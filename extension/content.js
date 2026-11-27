// Harness Bridge — content script for Gemini, ChatGPT and Claude.
//
// Flow: user sends a message -> we "arm" -> when the new model reply finishes
// streaming, we pull out `local-exec` JSON action blocks (shell commands and
// file tools), send each to the local bridge, handle trust / approval / diff /
// sandbox prompts in the overlay panel, stream live output, then paste the
// `local-result` blocks back into the chat box and press Send.
//
// Historic blocks (already on the page when it loads) never auto-run; they
// get a manual "Run locally" button instead.

(() => {
  'use strict';

  // ---- Per-site DOM adapters: the only part that should need upkeep ----
  // response:   top-level element of one assistant reply
  // userQuery:  a user message (used to detect a brand-new chat)
  // input:      the chat box (contenteditable)
  // send/stop:  composer buttons; `streaming` = extra "still generating" signal
  // insert:     'paste' (synthetic paste event first) or 'type' (execCommand first;
  //             claude.ai turns long pastes into attachments)
  const SITES = {
    'gemini.google.com': {
      name: 'Gemini',
      response: 'model-response, [data-test-id="model-response"]',
      userQuery: 'user-query, [data-test-id="user-query"]',
      input: 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"]',
      send: 'button[aria-label*="Send" i], button.send-button, button[data-test-id="send-button"]',
      stop: 'button[aria-label*="Stop" i]',
      streaming: null,
      codeLabel: '.code-block-decoration, [class*="code-block-decoration"]',
      insert: 'paste',
    },
    'chatgpt.com': {
      name: 'ChatGPT',
      response: '[data-message-author-role="assistant"]',
      userQuery: '[data-message-author-role="user"]',
      input: '#prompt-textarea, div.ProseMirror[contenteditable="true"], form textarea',
      send: 'button[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send" i]',
      stop: 'button[data-testid="stop-button"], button[aria-label*="Stop" i]',
      streaming: '.result-streaming',
      codeLabel: null,
      insert: 'type',
    },
    'claude.ai': {
      name: 'Claude',
      response: '[data-is-streaming], .font-claude-response, .font-claude-message',
      userQuery: '[data-testid="user-message"]',
      input: 'div.ProseMirror[contenteditable="true"], [data-testid="chat-input"] [contenteditable="true"], fieldset [contenteditable="true"]',
      send: 'button[aria-label="Send message"], button[aria-label*="Send" i]',
      stop: 'button[aria-label="Stop response"], button[aria-label*="Stop" i]',
      streaming: '[data-is-streaming="true"]',
      codeLabel: null,
      insert: 'type',
    },
  };
  SITES['chat.openai.com'] = SITES['chatgpt.com'];
  const SITE = SITES[location.hostname];
  if (!SITE) return;
  const SEL = SITE;

  const QUIET_MS = 2000; // reply considered finished after this long without DOM changes
  const ARM_TTL_MS = 10 * 60 * 1000;
  const MAX_KEYS = 1000;
  const LIVE_TAIL = 12_000; // chars of live output kept in the panel
  const TAG = 'local-exec';
  const PROTOCOL_MARK = '[harness-bridge protocol]';
  const RESULT_MARK = '[harness-bridge] results';
  const TOOLS = {
    'local-exec': (o) => typeof o.cmd === 'string' && o.cmd.trim() !== '',
    read_file: (o) => typeof o.path === 'string',
    write_file: (o) => typeof o.path === 'string' && typeof o.content === 'string',
    apply_patch: (o) => typeof o.path === 'string' && Array.isArray(o.edits),
  };
  const FILE_OPS = { read_file: 'read', write_file: 'write', apply_patch: 'patch' };

  const state = {
    settings: { autoRun: true, autoSend: true, collapsed: false },
    executed: new Set(), // keys of blocks already run (persisted)
    armedAt: 0,
    sawGenerating: false,
    diag: null,
    busy: false,
    bridge: 'unknown', // ok | down | unknown
    info: {}, // last pong: approval mode, sandbox, auto_accept_edits
    note: '',
    running: null, // { id, label, out }
  };

  // ---------------- utils ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props);
    for (const k of kids) n.append(k);
    return n;
  }

  const trusted = (fn) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.isTrusted) fn();
  };

  // ---------------- storage ----------------
  async function load() {
    try {
      const d = await chrome.storage.local.get(['settings', 'executed']);
      if (d.settings) Object.assign(state.settings, d.settings);
      if (Array.isArray(d.executed)) state.executed = new Set(d.executed);
    } catch {}
  }
  function saveSettings() {
    chrome.storage.local.set({ settings: state.settings }).catch(() => {});
  }
  function markExecuted(key) {
    state.executed.add(key);
    const arr = Array.from(state.executed).slice(-MAX_KEYS);
    chrome.storage.local.set({ executed: arr }).catch(() => {});
  }

  // ---------------- bridge ----------------
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) resolve({ status: 'error', error: chrome.runtime.lastError.message });
          else resolve(r ?? { status: 'error', error: 'no response from extension' });
        });
      } catch (e) {
        resolve({ status: 'error', error: `${e} (reload the page after reloading the extension)` });
      }
    });
  }
  const bridge = (payload) => send({ kind: 'bridge', payload });

  async function ping() {
    const r = await bridge({ type: 'ping' });
    state.bridge = r.type === 'pong' && r.status !== 'error' ? 'ok' : 'down';
    if (state.bridge === 'ok') state.info = r;
    state.note = state.bridge === 'ok' ? (r.auto_approve ? '⚠️ app auto-approve ON' : '') : r.error || '';
    render();
  }

  // The Ping button: same check, but always shows that something happened, since a
  // green dot that stays green looks like nothing was done.
  async function pingClicked() {
    state.note = 'Checking the connection…';
    render();
    await ping();
    if (state.bridge !== 'ok' || state.note) return;
    const msg = `✓ Connected to Harness Bridge${state.info.version ? ` ${state.info.version}` : ''}`;
    state.note = msg;
    render();
    setTimeout(() => {
      if (state.note === msg) {
        state.note = '';
        render();
      }
    }, 4000);
  }

  // Re-read the app's settings and project without touching the note (the user may
  // have run `harness-bridge OTHER_FOLDER` in Terminal since the last ping).
  async function refreshInfo() {
    const r = await bridge({ type: 'ping' });
    const up = r.type === 'pong' && r.status !== 'error';
    state.bridge = up ? 'ok' : 'down';
    if (up) state.info = r;
    render();
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.busy) refreshInfo();
  });

  // The folder `harness-bridge FOLDER` was started in. It goes with the instructions and
  // at the top of every results message, so copied instructions (Gems, Custom GPTs,
  // Claude Projects) and project switches stay correct.
  const projectLine = () => (state.info.project ? `Project folder: ${state.info.project}` : '');

  // Live output from the native host.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind !== 'progress' || !state.running || state.running.id !== msg.id) return;
    state.running.out = (state.running.out + msg.chunk).slice(-LIVE_TAIL);
    renderLive();
  });

  // ---------------- block detection ----------------
  function parseBlock(text, label) {
    let t = text
      .replace(/[​-‍﻿]/g, '') // zero-width characters some renderers insert
      .replace(/ /g, ' ') // non-breaking spaces break JSON.parse
      .trim()
      .replace(/^`{3,}\s*local-exec\s*/i, '')
      .replace(/^local-exec\s*/i, '') // a language label captured with the code
      .replace(/`{3,}\s*$/, '')
      .trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return null;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      try {
        obj = JSON.parse(t.replace(/[“”]/g, '"')); // curly quotes from "smart" rendering
      } catch {
        return null;
      }
    }
    if (!obj || typeof obj !== 'object') return null;
    const labelled = (label || '').toLowerCase().includes(TAG);
    if (!obj.tool && labelled && obj.cmd) obj.tool = TAG;
    if (!TOOLS[obj.tool] || !TOOLS[obj.tool](obj)) return null;
    obj.id = String(obj.id ?? `a-${hash(JSON.stringify(obj))}`);
    return obj;
  }

  // Scan the whole page for code-like elements whose text is a valid action. This
  // doesn't depend on each site's reply markup, which changes often. User messages,
  // the chat box and our own UI are skipped; for nested matches the innermost wins.
  const CODE_LIKE = 'pre, code, .cm-content, [data-language], [class*="code-block"], [class*="codeBlock"]';

  function labelOf(n) {
    const pre = n.closest('pre');
    return (
      (SEL.codeLabel && n.closest('code-block, .code-block')?.querySelector(SEL.codeLabel)?.textContent) ||
      n.getAttribute('data-language') ||
      n.className?.toString?.() ||
      pre?.querySelector('code')?.className ||
      ''
    );
  }

  function allBlocks() {
    const found = [];
    for (const n of $$(CODE_LIKE)) {
      if (n.closest('[data-hb-ui]') || n.closest(SEL.input) || (SEL.userQuery && n.closest(SEL.userQuery))) continue;
      const text = n.textContent || '';
      if (!text.includes('"tool"') && !text.includes('"cmd"')) continue;
      const req = parseBlock(text, labelOf(n));
      if (req) found.push({ pre: n, req, key: `${req.id}:${hash(JSON.stringify(req))}` });
    }
    return found.filter((b) => !found.some((o) => o !== b && b.pre.contains(o.pre)));
  }

  const isGenerating = () => !!$(SEL.stop) || (!!SEL.streaming && !!$(SEL.streaming));

  function labelFor(req) {
    switch (req.tool) {
      case 'local-exec':
        return req.cmd;
      case 'read_file':
        return `read ${req.path}${req.start_line ? `:${req.start_line}-${req.end_line ?? ''}` : ''}`;
      case 'write_file':
        return `write ${req.path}`;
      case 'apply_patch':
        return `edit ${req.path} (${req.edits.length} change${req.edits.length === 1 ? '' : 's'})`;
    }
    return req.tool;
  }

  function payloadFor(req) {
    if (req.tool === TAG) {
      const { id, cmd, cwd, timeout_s } = req;
      return { type: 'exec', id, cmd, cwd, timeout_s };
    }
    const { id, path, cwd, content, edits, start_line, end_line } = req;
    return { type: 'file', op: FILE_OPS[req.tool], id, path, cwd, content, edits, start_line, end_line };
  }

  // ---------------- per-block UI ----------------
  // Each block gets a bar in a *closed* shadow root: page scripts can't read or
  // restyle it, and the buttons only accept real (isTrusted) user clicks.
  const ui = new WeakMap(); // pre -> { host, status, key, highlight }

  const BAR_CSS = `
    .bar{display:inline-flex;gap:8px;align-items:center;margin:4px 0 8px;padding:3px 8px 3px 3px;
         font:12px system-ui;color:#e8e8e8;background:#1f1f1f;border:1px solid #444;border-radius:8px}
    .bar.ask{border-color:#f0a020}
    button{cursor:pointer;border:1px solid #555;border-radius:6px;padding:2px 10px;background:#333;color:#eee;font:inherit}
    button:hover{background:#444}`;

  function decorate(block) {
    const cur = ui.get(block.pre);
    if (cur && cur.key === block.key && cur.host.isConnected) return cur;
    cur?.host.remove();

    const host = el('div');
    host.dataset.hbUi = '1';
    const root = host.attachShadow({ mode: 'closed' });
    const status = el('span', { textContent: state.executed.has(block.key) ? '✓ already ran' : '' });
    const runBtn = el('button', { textContent: '▶ Run locally', title: labelFor(block.req) });
    runBtn.addEventListener('click', trusted(() => runBatch([block], { manual: true })));
    const bar = el('div', { className: 'bar' }, runBtn, status);
    root.append(el('style', { textContent: BAR_CSS }), bar);
    (block.pre.closest('pre') || block.pre).after(host);

    const entry = {
      host,
      key: block.key,
      status,
      highlight(on) {
        bar.classList.toggle('ask', on);
        if (on) host.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    };
    ui.set(block.pre, entry);
    return entry;
  }
  function setStatus(block, text) {
    decorate(block).status.textContent = text;
  }
  function decorateAll() {
    const blocks = allBlocks();
    for (const b of blocks) decorate(b);
    state.diag = {
      blocks: blocks.length,
      input: !!$(SEL.input),
      send: !!$(SEL.send),
      generating: isGenerating(),
    };
    return blocks;
  }

  // ---------------- run + reply ----------------
  function describe(r) {
    const via = r.approval === 'policy' ? ' · auto' : r.approval === 'inline' ? ' · approved' : '';
    const sb = r.sandbox === 'off' ? ' · no sandbox' : '';
    const masked = r.redacted ? ` · 🔒 ${r.redacted} secret${r.redacted === 1 ? '' : 's'} masked` : '';
    if (r.status === 'ok') {
      const ex = r.exit_code != null && r.exit_code !== 0 ? `✕ exit ${r.exit_code}` : '✓';
      return `${ex}${r.duration_ms ? ` (${r.duration_ms} ms)` : ''}${via}${sb}${masked}${r.sandbox_blocked ? ' · blocked by sandbox' : ''}`;
    }
    return `✕ ${r.status}${r.error ? `: ${r.error}` : ''}`;
  }

  function formatResults(results) {
    const keep = ['id', 'tool', 'status', 'exit_code', 'stdout', 'stderr', 'truncated', 'duration_ms', 'sandbox', 'sandbox_blocked', 'redacted', 'note', 'error'];
    const body = results
      .map((r) => {
        const clean = {};
        for (const k of keep) if (r[k] !== undefined && r[k] !== null && r[k] !== '' && r[k] !== false) clean[k] = r[k];
        return '```local-result\n' + JSON.stringify(clean, null, 2) + '\n```';
      })
      .join('\n\n');
    const project = projectLine();
    return `${RESULT_MARK}:\n\n${project ? `${project}\n\n` : ''}${body}`;
  }

  // Quick commands (most of them) finish before this and never open the output box,
  // so the panel doesn't flash open and shut. Slower ones open it and it stays open
  // until the batch ends.
  const LIVE_DELAY_MS = 1000;
  function startRunning(id, label) {
    state.running = { id, label, out: '', started: Date.now() };
    state.live = state.running;
    setTimeout(render, LIVE_DELAY_MS + 20);
  }

  // Ask the user (overlay panel) about a pending request; loops until it runs or is refused.
  async function resolvePrompts(b, payload, r) {
    const label = labelFor(b.req);
    for (let step = 0; step < 6; step++) {
      let choice;
      if (r.status === 'needs_trust') {
        const broad = (r.paths || []).some((p) => p === '/' || /^\/Users\/[^/]+$/.test(p));
        choice = await ask(b, {
          title: '📁 Trust this folder?',
          body: (r.paths || []).join('\n'),
          meta: `${SITE.name} wants to work here, starting with: ${label}`,
          why:
            'Trusted folders (and their subfolders) won’t ask again. Dangerous commands still need approval.' +
            (broad ? ' ⚠ This is your whole home folder or the disk root — prefer a project folder.' : ''),
          buttons: [
            ['Deny', 'deny', 'deny'],
            ['Allow once', 'once'],
            ['Trust folder', 'yes', 'run'],
          ],
        });
        if (choice === 'yes') {
          const t = await bridge({ type: 'trust', paths: r.paths || [] });
          if (t.errors?.length) state.note = `Trust failed: ${t.errors.join('; ')}`;
        } else if (choice === 'once') payload.trust_once = true;
      } else if (r.status === 'needs_approval' && r.diff) {
        choice = await ask(b, {
          title: `✏️ Review changes to ${b.req.path}`,
          diff: r.diff,
          meta: r.paths?.[0] || '',
          buttons: [
            ['Deny', 'deny', 'deny'],
            ['Apply & auto-accept edits', 'always'],
            ['Apply', 'yes', 'run'],
          ],
        });
        if (choice === 'always') await bridge({ type: 'allow_always', kind: 'edits' });
        if (choice !== 'deny') payload.approved = true;
      } else if (r.status === 'needs_approval') {
        const dialogMode = state.info.approval === 'dialog';
        choice = await ask(b, {
          title: b.req.tool === TAG ? `⚠ ${SITE.name} wants to run this command` : `⚠ ${SITE.name} wants to ${label}`,
          body: b.req.tool === TAG ? b.req.cmd : b.req.path,
          meta: `in ${b.req.cwd || state.info.project || '~'}${b.req.tool === TAG ? ` · timeout ${b.req.timeout_s || 60}s` : ''} · id ${b.req.id}`,
          why: r.error ? `Why it needs approval: ${r.error}` : '',
          buttons: [
            ['Deny', 'deny', 'deny'],
            ...(b.req.tool === TAG && !dialogMode ? [['Always allow', 'always']] : []),
            ['Run', 'yes', 'run'],
          ],
        });
        if (choice === 'always') {
          const a = await bridge({ type: 'allow_always', kind: 'cmd', cmd: b.req.cmd });
          if (a.rule) state.note = `Always allowed: ${a.rule}`;
        }
        if (choice !== 'deny') payload.approved = true;
      } else if (r.sandbox_blocked && !payload.unsandboxed) {
        choice = await ask(b, {
          title: '🛡 The sandbox blocked this command',
          body: (r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n'),
          meta: label,
          why: 'It tried to write outside the trusted folder or use the network. Retry with more access?',
          buttons: [
            ['Keep result', 'keep'],
            ...(payload.network ? [] : [['Retry with network', 'network']]),
            ['Retry without sandbox', 'nosandbox', 'run'],
          ],
        });
        if (choice === 'keep') return r;
        if (choice === 'network') payload.network = true;
        if (choice === 'nosandbox') payload.unsandboxed = true;
        payload.approved = true;
      } else {
        return r;
      }
      if (choice === 'deny') return { id: b.req.id, status: 'denied', error: 'user denied this action' };
      setStatus(b, '⏳ running…');
      startRunning(b.req.id, label);
      render();
      r = await bridge(payload);
    }
    return r;
  }

  // manual: the user clicked "Run locally" on this exact block (a trusted click).
  async function runBatch(blocks, { manual = false } = {}) {
    if (state.busy) return;
    state.busy = true;
    render();
    const results = [];
    try {
      for (const b of blocks) {
        const payload = payloadFor(b.req);
        // A manual click approves commands, but file edits still show their diff.
        payload.approved = manual && !['write_file', 'apply_patch'].includes(b.req.tool);
        setStatus(b, '⏳ running…');
        startRunning(b.req.id, labelFor(b.req));
        render();
        let r = await bridge(payload);
        r = await resolvePrompts(b, payload, r);
        state.running = null;
        if (r.status === 'error' && /not running|native host|Specified native/i.test(r.error || '')) state.bridge = 'down';
        else state.bridge = 'ok';
        markExecuted(b.key);
        setStatus(b, describe(r));
        results.push({ ...r, id: b.req.id, tool: b.req.tool });
      }
      await refreshInfo(); // current project folder for the results header
      await deliver(formatResults(results));
    } finally {
      state.running = null;
      state.live = null;
      state.liveShown = false;
      state.busy = false;
      render();
    }
  }

  // ---------------- chat box ----------------
  // Replace (or append to) the chat box text. Returns true if `marker` landed.
  async function putText(input, text, marker, { replace = false } = {}) {
    input.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    if (!replace) range.collapse(false);
    if (input.tagName === 'TEXTAREA') input.setSelectionRange(replace ? 0 : input.value.length, input.value.length);
    sel.removeAllRanges();
    sel.addRange(range);
    await sleep(60); // let the editor pick up the selection

    const landed = () => (input.innerText || input.value || '').includes(marker);
    const paste = () => {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } catch {}
    };
    const type = () => {
      if (input.tagName === 'TEXTAREA') {
        // React-controlled <textarea> fallback: use the native setter so React sees the change.
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(input, replace ? text : input.value + text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, text);
      }
    };
    const [first, second] = SITE.insert === 'type' ? [type, paste] : [paste, type];
    first();
    if (landed()) return true;
    await sleep(60);
    if (landed()) return true;
    second();
    return landed();
  }

  async function clickSend() {
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const btn = $(SEL.send);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        arm();
        btn.click();
        return true;
      }
    }
    return false;
  }

  async function deliver(text) {
    const input = $(SEL.input);
    if (!input || !(await putText(input, text, RESULT_MARK))) {
      await navigator.clipboard.writeText(text).catch(() => {});
      state.note = 'Could not fill the chat box — results copied to clipboard, paste manually.';
      render();
      return;
    }
    if (state.settings.autoSend && !(await clickSend())) {
      state.note = 'Send button not found/enabled — press Send yourself.';
      render();
    }
  }

  // ---------------- protocol instructions (bundled in the extension) ----------------
  // Nothing is added automatically. "Add instructions" puts them at the top of the
  // chat box (above anything you typed) so they go out with the message you send next;
  // "Copy" is for pasting into a Gem, Custom GPT or Claude Project.
  let protocolText = '';
  async function getProtocol() {
    if (!protocolText) protocolText = ((await send({ kind: 'protocol' })).text || '').trim();
    return protocolText;
  }

  async function addInstructions() {
    const input = $(SEL.input);
    const text = await getProtocol();
    if (!input || !text) {
      state.note = !input ? 'Chat box not found.' : 'Instructions unavailable — reload the extension.';
      return render();
    }
    const current = (input.innerText || input.value || '').trim();
    if (current.includes(PROTOCOL_MARK)) {
      state.note = 'Instructions are already in the chat box.';
      return render();
    }
    // Tell the model which folder it's in, so it can leave out "cwd".
    await ping();
    const project = projectLine()
      ? `\n\n${projectLine()}\nActions run there by default: leave out "cwd", and use paths relative to it.`
      : '';
    const block = `${text}${project}\n\n---\n\n`;
    const ok = await putText(input, current ? `${block}${current}` : block, PROTOCOL_MARK, { replace: true });
    state.note = ok ? 'Instructions added to the chat box — type your request below them and press Send.' : 'Could not fill the chat box; use Copy and paste instead.';
    render();
  }

  async function copyInstructions() {
    const text = await getProtocol();
    try {
      await navigator.clipboard.writeText(text);
      state.note = 'Instructions copied. The project folder is added to every result, so they work in any project.';
    } catch {
      state.note = 'Copy failed; open prompts/instructions.md instead.';
    }
    render();
  }

  // ---------------- arming + scanning ----------------
  // Arming takes a snapshot of the action blocks already on the page. When the reply
  // has finished, any block that wasn't in the snapshot (and hasn't run before) runs.
  let snapshot = new Set();
  function arm() {
    state.armedAt = Date.now();
    state.sawGenerating = false;
    snapshot = new Set(allBlocks().map((b) => b.key));
    render();
  }
  const disarm = () => {
    state.armedAt = 0;
    render();
  };
  // Without a visible "stop" signal we can't tell a reply has started, so give up sooner.
  const armed = () =>
    !!state.armedAt && Date.now() - state.armedAt < (state.sawGenerating ? ARM_TTL_MS : 3 * 60 * 1000);

  let quietTimer = 0;
  function schedule() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(onQuiet, QUIET_MS);
  }

  async function onQuiet() {
    const blocks = decorateAll();
    render();
    if (!armed() || state.busy || !state.settings.autoRun) return;
    if (isGenerating()) {
      state.sawGenerating = true;
      return schedule();
    }
    const fresh = blocks.filter((b) => !snapshot.has(b.key) && !state.executed.has(b.key));
    if (fresh.length) {
      disarm();
      await runBatch(fresh);
    } else if (state.sawGenerating) {
      disarm(); // the reply finished without any actions
    } else {
      schedule(); // reply hasn't started yet
    }
  }

  // Arm when the user sends a message: Enter in any text box, or a send-like button.
  const isEditable = (t) => !!t && (t.isContentEditable || t.tagName === 'TEXTAREA') && !t.closest('[data-hb-ui]');
  const isSendButton = (t) => {
    const b = t?.closest?.('button, [role="button"]');
    if (!b || b.closest('[data-hb-ui]')) return false;
    return b.matches(SEL.send) || /send|submit/i.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-testid') || ''}`);
  };
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && isEditable(e.target)) arm();
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted && isSendButton(e.target)) arm();
    },
    true,
  );
  // A reply that starts streaming without Enter/Send (e.g. voice input) also arms.
  let lastGenCheck = 0;
  function watchGenerating() {
    const now = Date.now();
    if (now - lastGenCheck < 500) return;
    lastGenCheck = now;
    if (isGenerating()) {
      if (!armed()) arm();
      state.sawGenerating = true;
    }
  }

  // ---------------- overlay panel (status, live output, prompts) ----------------
  // Closed shadow root: the page can't read or restyle it; buttons require trusted clicks.
  let pill;
  const approvals = []; // queue of { block, item, resolve }

  function ask(block, item) {
    decorate(block).highlight(true);
    setStatus(block, '⏸ waiting for you (see Harness Bridge panel)');
    if (document.hidden || !document.hasFocus()) {
      send({ kind: 'notify', title: item.title.replace(/^\W+/, ''), message: labelFor(block.req) });
    }
    return new Promise((resolve) => {
      approvals.push({ block, item, resolve });
      render();
    }).finally(() => decorate(block).highlight(false));
  }
  function settle(value) {
    const a = approvals.shift();
    a?.resolve(value);
    if (!approvals.length) send({ kind: 'notify-clear' });
    render();
  }

  const PANEL_CSS = `
    :host{all:initial}
    .p{font:13px/1.45 system-ui,-apple-system,sans-serif;background:#1c1d20;color:#e8e8e8;border:1px solid #34363b;
       border-radius:14px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;
       width:min(320px,calc(100vw - 32px));overflow:auto;box-shadow:0 10px 30px #0009}
    .p.asking{border-color:#d9962b}
    .p.min{gap:0;padding-bottom:10px}
    .p.min .body{display:none}
    .head{display:flex;align-items:center;gap:6px;cursor:grab;user-select:none}
    .head.dragging{cursor:grabbing}
    .dot{width:8px;height:8px;border-radius:50%;flex:none;margin-right:2px}
    .name{font-weight:600;white-space:nowrap}
    .status{color:#8b8f96;font-size:12px;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;
          border:0;border-radius:7px;background:transparent;color:#9da1a8}
    .icon:hover,.icon.on{background:#2c2e33;color:#fff}
    .icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .body{display:flex;flex-direction:column;gap:10px}
    .proj{display:flex;align-items:center;gap:6px;min-width:0}
    .folder{font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:auto}
    .folder.none{font-weight:400;color:#8b8f96}
    .chip{font-size:11px;padding:1px 8px;border-radius:999px;background:#2a2c31;color:#a9adb4;white-space:nowrap;flex:none}
    .chip.warn{background:#4a2b12;color:#ffb366}
    button{font:inherit;cursor:pointer;background:#2a2c31;color:#e8e8e8;border:1px solid #3d4046;border-radius:8px;padding:5px 10px}
    button:hover{background:#34363c}
    .note{font-size:12px;color:#f3b469}
    .note.ok{color:#7ee787}
    .note:empty{display:none}
    .menu{display:none;flex-direction:column;gap:8px;padding:10px;border-radius:10px;background:#232428}
    .menu.on{display:flex}
    label{display:flex;gap:8px;align-items:center;cursor:pointer;color:#d0d3d8;font-size:12px}
    .diag{color:#7d8188;font-size:11px}
    .section{display:none;flex-direction:column;gap:8px;border-top:1px solid #34363b;padding-top:10px}
    .section.on{display:flex}
    .title{font-weight:600;color:#ffcf7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .live .title{color:#9ecbff}
    pre{margin:0;padding:8px 10px;background:#0f1012;color:#f5f5f5;border:1px solid #2c2e33;border-radius:8px;
        font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;
        max-height:220px;overflow:auto}
    .live pre{height:140px;max-height:none}
    .d-add{color:#7ee787;background:#2ea04326;display:block}
    .d-del{color:#ffa198;background:#f8514926;display:block}
    .d-hunk{color:#79c0ff;display:block}
    .d-file{color:#a8a8a8;display:block}
    .meta{color:#b5b5b5;font-size:12px;word-break:break-all}
    .why{color:#f3b469;font-size:12px}
    .actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
    .run{background:#2e7d32;border-color:#2e7d32;color:#fff;font-weight:600}
    .run:hover{background:#388e3c}
    .deny{background:transparent;border-color:#e57373;color:#ff8a80}
    .deny:hover{background:#e5737322}
    .stopbtn{border-color:#e57373;color:#ff8a80;background:transparent}
    .stopbtn:disabled{opacity:.4;cursor:default}
    .queue{color:#a8a8a8;font-size:12px;margin-right:auto;align-self:center}`;

  // Small line icons, built node by node (no innerHTML: some chat sites enforce Trusted Types).
  const ICONS = {
    refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 4v5h-5'],
    copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
    settings: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 5v4', 'M9 15v4'],
    down: ['M6 9l6 6 6-6'],
    up: ['M6 15l6-6 6 6'],
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }
  function iconButton(name, label, onClick, title = label) {
    const b = el('button', { className: 'icon', title });
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    b.addEventListener('click', trusted(onClick));
    return b;
  }

  function renderDiff(pre, diff) {
    pre.replaceChildren();
    for (const line of diff.split('\n')) {
      const cls = line.startsWith('+++') || line.startsWith('---')
        ? 'd-file'
        : line.startsWith('@@')
          ? 'd-hunk'
          : line.startsWith('+')
            ? 'd-add'
            : line.startsWith('-')
              ? 'd-del'
              : '';
      pre.append(el('span', { className: cls, textContent: line + '\n' }));
    }
  }

  // Output stays on screen for the whole batch (state.live keeps the last command), so
  // the panel doesn't collapse and re-open between commands.
  function renderLive() {
    if (!pill) return;
    const run = state.running || state.live;
    if (state.running && Date.now() - state.running.started >= LIVE_DELAY_MS) state.liveShown = true;
    pill.live.classList.toggle('on', !!run && state.busy && !approvals.length && !!state.liveShown);
    pill.stop.disabled = !state.running;
    if (!run) return;
    pill.liveTitle.textContent = `${state.running ? '▶ Running' : '✓ Done'}: ${run.label}`;
    const atBottom = pill.liveOut.scrollTop + pill.liveOut.clientHeight >= pill.liveOut.scrollHeight - 20;
    pill.liveOut.textContent = run.out || '(no output yet)';
    if (atBottom) pill.liveOut.scrollTop = pill.liveOut.scrollHeight;
  }

  // ---- position: top-right by default, away from the chat box; drag the header to move ----
  // Stored as distance from the top and right edges, so it stays in the same corner
  // when the window is resized.
  let pill_host;
  const DEFAULT_POS = { top: 72, right: 16 };
  function placePanel() {
    if (!pill_host) return;
    const pos = state.settings.pos || DEFAULT_POS;
    const top = Math.min(Math.max(8, pos.top), Math.max(8, window.innerHeight - 56));
    const right = Math.min(Math.max(8, pos.right), Math.max(8, window.innerWidth - 120));
    pill_host.style.top = `${top}px`;
    pill_host.style.right = `${right}px`;
    // Grow downwards, but never past the bottom of the window.
    if (pill) pill.panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - 16)}px`;
  }
  function makeDraggable(head) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const start = { x: e.clientX, y: e.clientY, ...(state.settings.pos || DEFAULT_POS) };
      head.classList.add('dragging');
      head.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        state.settings.pos = { top: start.top + (ev.clientY - start.y), right: start.right - (ev.clientX - start.x) };
        placePanel();
      };
      const up = () => {
        head.classList.remove('dragging');
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        saveSettings();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
    // Double-click the header to put it back in the default corner.
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      delete state.settings.pos;
      saveSettings();
      placePanel();
    });
  }

  function statusText() {
    if (approvals.length) return 'needs you';
    if (state.running) return `running: ${state.running.label}`;
    if (state.busy) return 'working';
    if (state.bridge === 'down') return 'not connected';
    if (armed()) return 'waiting for reply';
    return 'ready';
  }

  function render() {
    if (!pill) {
      const host = el('div');
      host.dataset.hbUi = '1';
      host.style.cssText = 'position:fixed;z-index:2147483647;';
      document.documentElement.append(host);
      pill_host = host;
      placePanel();
      window.addEventListener('resize', placePanel);
      const root = host.attachShadow({ mode: 'closed' });
      pill = {
        panel: el('div', { className: 'p' }),
        dot: el('span', { className: 'dot' }),
        status: el('span', { className: 'status' }),
        folder: el('span', { className: 'folder' }),
        chips: el('span', { className: 'proj' }),
        note: el('div', { className: 'note' }),
        diag: el('div', { className: 'diag' }),
        menu: el('div', { className: 'menu' }),
        autoRun: el('input', { type: 'checkbox' }),
        autoSend: el('input', { type: 'checkbox' }),
        // live output
        live: el('div', { className: 'section live' }),
        liveTitle: el('div', { className: 'title' }),
        liveOut: el('pre'),
        stop: el('button', { className: 'stopbtn', textContent: '■ Stop' }),
        // prompt card
        card: el('div', { className: 'section' }),
        title: el('div', { className: 'title' }),
        body: el('pre'),
        meta: el('div', { className: 'meta' }),
        why: el('div', { className: 'why' }),
        actions: el('div', { className: 'actions' }),
        shown: null,
      };
      for (const k of ['autoRun', 'autoSend']) {
        pill[k].onchange = () => ((state.settings[k] = pill[k].checked), saveSettings());
      }
      const menuBtn = iconButton('settings', 'Settings', () => {
        pill.menu.classList.toggle('on');
        menuBtn.classList.toggle('on', pill.menu.classList.contains('on'));
      });
      pill.minBtn = iconButton('down', 'Minimize', () => {
        state.settings.collapsed = !state.settings.collapsed;
        saveSettings();
        render();
      });
      const addBtn = el('button', {
        textContent: 'Add instructions',
        title: 'Put the Harness Bridge instructions at the top of the chat box. Use it once, in the first message of a chat.',
      });
      addBtn.addEventListener('click', trusted(addInstructions));
      pill.stop.addEventListener('click', trusted(() => state.running && bridge({ type: 'stop', id: state.running.id })));

      pill.menu.append(
        el('label', { title: 'Run actions in new replies without clicking Run locally' }, pill.autoRun, 'Run actions automatically'),
        el('label', { title: 'Paste results into the chat box and press Send' }, pill.autoSend, 'Send results automatically'),
        pill.diag,
      );
      pill.live.append(pill.liveTitle, pill.liveOut, el('div', { className: 'actions' }, pill.stop));
      pill.card.append(pill.title, pill.body, pill.meta, pill.why, pill.actions);

      const name = el('span', { className: 'name', textContent: 'Harness Bridge', title: `Harness Bridge on ${SITE.name}` });
      const head = el(
        'div',
        { className: 'head', title: 'Drag to move' },
        pill.dot,
        name,
        pill.status,
        iconButton('refresh', 'Check connection', pingClicked),
        iconButton('copy', 'Copy instructions', copyInstructions, 'Copy instructions, for a Gem, Custom GPT or Claude Project'),
        menuBtn,
        pill.minBtn,
      );
      makeDraggable(head);
      pill.panel.append(
        head,
        el('div', { className: 'body' }, el('div', { className: 'proj' }, pill.folder, pill.chips), pill.menu, addBtn, pill.note),
        pill.live,
        pill.card,
      );
      root.append(el('style', { textContent: PANEL_CSS }), pill.panel);
      placePanel(); // now that the panel exists, also cap its height
    }

    const i = state.info;
    pill.dot.style.background = { ok: '#4caf50', down: '#e53935', unknown: '#777' }[state.bridge];
    pill.status.textContent = statusText();

    // Minimized: only the header row, but never while something needs attention.
    const active = approvals.length > 0 || state.busy;
    const min = !!state.settings.collapsed && !active;
    pill.panel.classList.toggle('min', min);
    pill.minBtn.replaceChildren(icon(min ? 'up' : 'down'));
    pill.minBtn.title = min ? 'Expand' : 'Minimize';
    pill.minBtn.setAttribute('aria-label', pill.minBtn.title);

    // Project: name, full path on hover. Chips only for the mode and for unusual settings.
    pill.folder.textContent = i.project
      ? `📁 ${i.project_name || i.project}`
      : state.bridge === 'ok'
        ? 'No project. In Terminal: harness-bridge .'
        : '';
    pill.folder.classList.toggle('none', !i.project);
    pill.folder.title = i.project ? `${i.project}\nThe model is told this folder with every result.` : '';
    const modeName = { auto: 'Auto', inline: 'Allowlist', dialog: 'Allowlist' }[i.approval];
    const chip = (text, title, warn = false) => el('span', { className: warn ? 'chip warn' : 'chip', textContent: text, title });
    pill.chips.replaceChildren(
      ...(modeName
        ? [
            chip(modeName, `Approval: ${modeName}${i.approval === 'dialog' ? ' + macOS dialog' : ''} · Sandbox: ${i.sandbox ? 'on' : 'off'} · File edits: ${i.auto_accept_edits ? 'auto-accepted' : 'reviewed'}`),
            ...(i.sandbox ? [] : [chip('Sandbox off', 'Commands run without the macOS sandbox', true)]),
            ...(i.auto_accept_edits ? [chip('Edits auto', 'File edits are applied without review', true)] : []),
            ...(i.auto_approve ? [chip('Auto-approve', 'HARNESS_BRIDGE_AUTO_APPROVE is set: nothing asks', true)] : []),
          ]
        : []),
    );

    for (const k of ['autoRun', 'autoSend']) pill[k].checked = state.settings[k];
    const dg = state.diag || {};
    pill.diag.textContent = `Seen on page: ${dg.blocks ?? 0} action block${dg.blocks === 1 ? '' : 's'} · chat box ${dg.input ? '✓' : '✗'} · send button ${dg.send ? '✓' : '✗'}${dg.generating ? ' · generating' : ''}`;
    const fallback = state.bridge === 'down' ? 'Harness Bridge app not reachable.' : dg.input === false ? 'Chat box not found on this page.' : '';
    pill.note.textContent = state.note || fallback;
    pill.note.classList.toggle('ok', pill.note.textContent.startsWith('✓'));

    const a = approvals[0];
    pill.card.classList.toggle('on', !!a);
    pill.panel.classList.toggle('asking', !!a);
    if (a && pill.shown !== a) {
      pill.shown = a;
      const it = a.item;
      pill.title.textContent = it.title;
      if (it.diff) renderDiff(pill.body, it.diff);
      else pill.body.textContent = it.body || '';
      pill.body.style.display = it.diff || it.body ? '' : 'none';
      pill.meta.textContent = it.meta || '';
      pill.why.textContent = it.why || '';
      const queue = el('span', { className: 'queue', textContent: approvals.length > 1 ? `+${approvals.length - 1} more queued` : '' });
      pill.actions.replaceChildren(
        queue,
        ...it.buttons.map(([label, value, cls]) => {
          const b = el('button', { textContent: label, className: cls || '' });
          b.addEventListener('click', trusted(() => settle(value)));
          return b;
        }),
      );
    }
    if (!a) pill.shown = null;
    renderLive();
  }

  // ---------------- boot ----------------
  (async () => {
    await load();
    decorateAll(); // also fills the diagnostics line
    render();
    ping();
    setInterval(() => document.visibilityState === 'visible' && !state.busy && refreshInfo(), 20000); // picks up menu-bar changes, keeps the note
    new MutationObserver(() => {
      watchGenerating();
      schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
  })();
})();
