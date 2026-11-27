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
    settings: { autoRun: true, autoSend: true },
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
    return `${RESULT_MARK}:\n\n${body}`;
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
      state.running = { id: b.req.id, label, out: '' };
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
        state.running = { id: b.req.id, label: labelFor(b.req), out: '' };
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
      await deliver(formatResults(results));
    } finally {
      state.running = null;
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
    const project = state.info.project
      ? `\n\nProject folder: ${state.info.project}\nActions run there by default: leave out "cwd", and use paths relative to it.`
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
      state.note = 'Instructions copied.';
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
    .p{font:13px/1.4 system-ui,-apple-system,sans-serif;background:#1e1f22;color:#ececec;border:1px solid #3c3f44;
       border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;
       box-shadow:0 8px 28px #0008;width:300px;box-sizing:border-box;max-height:calc(100vh - 120px);overflow:auto}
    .p.wide{width:min(520px,calc(100vw - 32px))}
    .p.asking{border-color:#f0a020}
    .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .dot{width:9px;height:9px;border-radius:50%;flex:none}
    .mode{color:#a8a8a8}
    label{display:flex;gap:4px;align-items:center;cursor:pointer;color:#d0d0d0}
    button{font:inherit;cursor:pointer;background:#2f3136;color:#ececec;border:1px solid #4a4d52;border-radius:7px;padding:2px 8px}
    button:hover{background:#3a3d42}
    .note{color:#f3b469}
    .modeline{color:#9ecbff;font-size:12px}
    .project{color:#e6e6e6;font-size:12px;font-weight:600;word-break:break-all}
    .diag{color:#8a8f98;font-size:11px}
    .section{display:none;flex-direction:column;gap:8px;border-top:1px solid #3c3f44;padding-top:8px;margin-top:2px}
    .section.on{display:flex}
    .title{font-weight:600;color:#ffcf7a}
    .live .title{color:#9ecbff}
    pre{margin:0;padding:8px 10px;background:#0f1012;color:#f5f5f5;border:1px solid #33363b;border-radius:8px;
        font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;
        max-height:220px;overflow:auto}
    .d-add{color:#7ee787;background:#2ea04326;display:block}
    .d-del{color:#ffa198;background:#f8514926;display:block}
    .d-hunk{color:#79c0ff;display:block}
    .d-file{color:#a8a8a8;display:block}
    .meta{color:#b5b5b5;font-size:12px;word-break:break-all}
    .why{color:#f3b469;font-size:12px}
    .actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
    .actions button{padding:5px 12px}
    .run{background:#2e7d32;border-color:#2e7d32;color:#fff;font-weight:600}
    .run:hover{background:#388e3c}
    .deny{background:transparent;border-color:#e57373;color:#ff8a80}
    .deny:hover{background:#e5737322}
    .stopbtn{border-color:#e57373;color:#ff8a80;background:transparent}
    .queue{color:#a8a8a8;font-size:12px;margin-right:auto;align-self:center}`;

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

  function renderLive() {
    if (!pill) return;
    const run = state.running;
    pill.live.classList.toggle('on', !!run && !approvals.length);
    if (!run) return;
    pill.liveTitle.textContent = `▶ Running: ${run.label}`;
    const atBottom = pill.liveOut.scrollTop + pill.liveOut.clientHeight >= pill.liveOut.scrollHeight - 20;
    pill.liveOut.textContent = run.out || '(no output yet)';
    if (atBottom) pill.liveOut.scrollTop = pill.liveOut.scrollHeight;
    pill.panel.classList.toggle('wide', true);
  }

  function render() {
    if (!pill) {
      const host = el('div');
      host.dataset.hbUi = '1';
      host.style.cssText = 'position:fixed;right:16px;bottom:96px;z-index:2147483647;';
      document.documentElement.append(host);
      const root = host.attachShadow({ mode: 'closed' });
      pill = {
        panel: el('div', { className: 'p' }),
        dot: el('span', { className: 'dot' }),
        mode: el('span', { className: 'mode' }),
        modeLine: el('div', { className: 'modeline' }),
        project: el('div', { className: 'project' }),
        note: el('div', { className: 'note' }),
        diag: el('div', { className: 'diag' }),
        autoRun: el('input', { type: 'checkbox' }),
        autoSend: el('input', { type: 'checkbox' }),
        // live output
        live: el('div', { className: 'section live' }),
        liveTitle: el('div', { className: 'title' }),
        liveOut: el('pre'),
        // prompt card
        card: el('div', { className: 'section' }),
        title: el('div', { className: 'title' }),
        body: el('pre'),
        meta: el('div', { className: 'meta' }),
        why: el('div', { className: 'why' }),
        actions: el('div', { className: 'actions' }),
        shown: null,
      };
      const pingBtn = el('button', { textContent: 'Ping' });
      pingBtn.addEventListener('click', trusted(ping));
      for (const k of ['autoRun', 'autoSend']) {
        pill[k].onchange = () => ((state.settings[k] = pill[k].checked), saveSettings());
      }
      const addBtn = el('button', {
        textContent: 'Add instructions',
        title: 'Put the Harness Bridge instructions at the top of the chat box. Use it once, in the first message of a chat.',
      });
      addBtn.addEventListener('click', trusted(addInstructions));
      const copyBtn = el('button', { textContent: 'Copy instructions', title: 'For a Gem, Custom GPT or Claude Project' });
      copyBtn.addEventListener('click', trusted(copyInstructions));
      const stopBtn = el('button', { className: 'stopbtn', textContent: '■ Stop' });
      stopBtn.addEventListener('click', trusted(() => state.running && bridge({ type: 'stop', id: state.running.id })));
      pill.live.append(el('div', { className: 'row' }, pill.liveTitle), pill.liveOut, el('div', { className: 'actions' }, stopBtn));
      pill.card.append(pill.title, pill.body, pill.meta, pill.why, pill.actions);

      pill.panel.append(
        el('div', { className: 'row' }, pill.dot, el('b', { textContent: `Harness Bridge · ${SITE.name}` }), pill.mode, pingBtn),
        pill.project,
        pill.modeLine,
        el(
          'div',
          { className: 'row' },
          el('label', {}, pill.autoRun, 'Auto-run'),
          el('label', {}, pill.autoSend, 'Auto-send results'),
        ),
        el('div', { className: 'row' }, addBtn, copyBtn),
        pill.note,
        pill.diag,
        pill.live,
        pill.card,
      );
      root.append(el('style', { textContent: PANEL_CSS }), pill.panel);
    }

    pill.dot.style.background = { ok: '#4caf50', down: '#e53935', unknown: '#999' }[state.bridge];
    pill.mode.textContent = approvals.length
      ? '· needs you'
      : state.running
        ? '· running'
        : state.busy
          ? '· working'
          : armed()
            ? '· armed'
            : '· idle';
    const i = state.info;
    const modeName = { auto: 'Auto', inline: 'Allowlist', dialog: 'Allowlist + dialog' }[i.approval];
    pill.modeLine.textContent = modeName
      ? `Mode: ${modeName} · Sandbox ${i.sandbox ? 'on' : 'OFF'} · Edits: ${i.auto_accept_edits ? 'auto-accept' : 'review'}`
      : '';
    pill.project.textContent = i.project ? `📁 ${i.project_name || i.project}` : state.bridge === 'ok' ? 'No project — run: harness-bridge <folder>' : '';
    pill.project.title = i.project || '';
    for (const k of ['autoRun', 'autoSend']) pill[k].checked = state.settings[k];
    const dg = state.diag || {};
    pill.diag.textContent = `Seen on page: ${dg.blocks ?? 0} action block${dg.blocks === 1 ? '' : 's'} · chat box ${dg.input ? '✓' : '✗'} · send button ${dg.send ? '✓' : '✗'}${dg.generating ? ' · generating' : ''}`;
    pill.note.textContent = state.bridge === 'down' && !state.note ? 'Bridge app/host not reachable.' : state.note;

    const a = approvals[0];
    pill.card.classList.toggle('on', !!a);
    pill.panel.classList.toggle('asking', !!a);
    pill.panel.classList.toggle('wide', !!a || !!state.running);
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
    setInterval(() => document.visibilityState === 'visible' && !state.busy && ping(), 20000); // picks up menu-bar changes
    new MutationObserver(() => {
      watchGenerating();
      schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
  })();
})();
