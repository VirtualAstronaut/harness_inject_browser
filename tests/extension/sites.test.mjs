// Runs the basic flow on fake versions of each chat site:
// Add instructions -> send -> reply with 2 actions -> run / review diff -> results sent back.

import { checker, esc, makePage, report, sleep } from './harness.mjs';

const BLOCKS = [
  { tool: 'local-exec', id: 'c1', cmd: 'ls -la' },
  { tool: 'apply_patch', id: 'c2', path: 'src/app.js', edits: [{ old: 'port = 3000', new: 'port = 8080' }] },
];

const SITES = {
  gemini: {
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    body: `<div id="chat"></div><rich-textarea><div contenteditable="true" role="textbox"></div></rich-textarea><button id="send" aria-label="Send message">send</button>`,
    user: (t) => `<user-query>${esc(t.slice(0, 40))}</user-query>`,
    reply: (code) => `<model-response><p>Sure.</p>${code}</model-response>`,
    code: (j) => `<code-block><div class="code-block-decoration">local-exec</div><pre><code>${esc(j)}</code></pre></code-block>`,
    quillPaste: true,
  },
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    body: `<div id="chat"></div><div><div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div><button id="send" data-testid="send-button">↑</button></div>`,
    user: (t) => `<div data-message-author-role="user">${esc(t.slice(0, 40))}</div>`,
    reply: (code) => `<div data-message-author-role="assistant"><div class="markdown">Sure.${code}</div></div>`,
    code: (j) => `<pre><div class="hdr"><div>local-exec</div><button>Copy code</button></div><div><code class="language-local-exec">${esc(j)}</code></div></pre>`,
  },
  chatgpt_unknown_markup: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    body: `<div id="chat"></div><div><div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div><button id="send" data-testid="send-button">↑</button></div>`,
    user: (t) => `<article><div class="whitespace-pre-wrap">${esc(t.slice(0, 40))}</div></article>`,
    reply: (code) => `<article><div class="agent-turn"><p>I'll inspect the project.</p>${code}</div></article>`,
    // CodeMirror-style block, JSON with non-breaking spaces
    code: (j) => `<div class="cb-wrap"><div class="cb-head">local-exec<button>copy</button></div><div class="cm-editor"><div class="cm-content"><div class="cm-line">${esc(j).replace(/ /g, ' ')}</div></div></div></div>`,
  },
  claude: {
    name: 'Claude',
    url: 'https://claude.ai/new',
    body: `<div id="chat"></div><fieldset><div class="ProseMirror" contenteditable="true"></div><button id="send" aria-label="Send message">↑</button></fieldset>`,
    user: (t) => `<div data-testid="user-message">${esc(t.slice(0, 40))}</div>`,
    reply: (code) => `<div data-is-streaming="true"><div class="font-claude-response">Sure.${code}</div></div>`,
    code: (j) => `<pre class="code-block__code"><div class="lang">local-exec</div><code class="language-local-exec">${esc(j)}</code></pre>`,
    streamMs: 3000, // stays "streaming" longer than the 2 s quiet window
  },
};

const reply = (p) => {
  if (p.type === 'ping') return { type: 'pong', approval: 'auto', sandbox: true, auto_accept_edits: false, project: '/Users/me/projects/my-app', project_name: 'my-app' };
  if (p.id === 'c1') return { type: 'result', id: 'c1', status: 'ok', exit_code: 0, stdout: 'API_KEY=[REDACTED:openai-key]\n', redacted: 1, sandbox: 'workspace-write', approval: 'policy' };
  if (p.id === 'c2') {
    return p.approved
      ? { type: 'result', id: 'c2', status: 'ok', exit_code: 0, stdout: 'updated src/app.js (+1 -1 lines)' }
      : { type: 'result', id: 'c2', status: 'needs_approval', diff: '--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-port = 3000\n+port = 8080\n' };
  }
  return { status: 'error' };
};

async function runSite(key, S) {
  const { log, ok } = checker(`[${key}] `);
  const pg = await makePage({ url: S.url, body: S.body, reply, quillPaste: !!S.quillPaste });
  const { d, input, panel, card, button, click, enter, waitFor, calls, counts } = pg;

  // Fake site: Send posts the message; the first message gets a reply with 2 actions.
  const sent = [];
  d.getElementById('send').addEventListener('click', () => {
    const text = input.textContent;
    sent.push(text);
    input.textContent = '';
    d.getElementById('chat').insertAdjacentHTML('beforeend', S.user(text));
    if (sent.length === 1) {
      setTimeout(() => {
        d.getElementById('chat').insertAdjacentHTML('beforeend', S.reply(BLOCKS.map((b) => S.code(JSON.stringify(b))).join('')));
        if (S.streamMs) setTimeout(() => d.querySelector('[data-is-streaming]').setAttribute('data-is-streaming', 'false'), S.streamMs);
      }, 200);
    }
  });

  await waitFor(() => panel()?.textContent.includes('📁 my-app'), 2000);
  ok(panel()?.textContent.includes(`Harness Bridge · ${S.name}`), 'panel loaded with site name');
  ok(panel()?.textContent.includes('📁 my-app'), 'panel shows the project name');
  ok(/Seen on page: 0 action blocks · chat box ✓ · send button ✓/.test(panel()?.textContent), 'diagnostics: chat box + send button found');

  input.textContent = 'list my files';
  ok(!enter(input).defaultPrevented, 'Enter is not intercepted (nothing added automatically)');
  ok(!!button('Add instructions') && !!button('Copy instructions'), 'panel has Add / Copy instructions');
  click(button('Add instructions'));
  ok(await waitFor(() => input.textContent.startsWith('[harness-bridge protocol]') && input.textContent.endsWith('list my files')), 'instructions placed above the typed text');
  ok(input.textContent.includes('Project folder: /Users/me/projects/my-app') && input.textContent.indexOf('Project folder') < input.textContent.indexOf('list my files'), 'instructions include the project folder');
  ok(sent.length === 0, 'nothing sent automatically');
  click(button('Add instructions'));
  await sleep(150);
  ok((input.textContent.match(/\[harness-bridge protocol\]/g) || []).length === 1, 'a second click does not duplicate');
  ok(S.quillPaste ? counts.pastes > 0 : counts.pastes === 0, S.quillPaste ? 'used paste (Quill)' : 'typed, no paste event (avoids claude.ai attachments)');

  click(d.getElementById('send'));
  ok(sent[0]?.startsWith('[harness-bridge protocol]') && sent[0].endsWith('list my files'), 'first message sent with instructions');

  ok(await waitFor(() => calls.some((c) => c.id === 'c1')), 'c1 found and run');
  const c1 = calls.find((c) => c.id === 'c1');
  ok(c1?.cmd === 'ls -la' && c1.cwd === undefined, 'command parsed exactly; no cwd sent, so the app uses the project folder');
  ok(/Seen on page: 2 action blocks/.test(panel()?.textContent), 'diagnostics count the 2 blocks');
  if (S.streamMs) ok(c1.t - calls[0].t >= S.streamMs, `waited for streaming to finish (${c1.t - calls[0].t} ms)`);
  ok(await waitFor(() => card()?.classList.contains('on') && card().textContent.includes('Review changes to src/app.js')), 'diff card shown');
  click(button('Apply', card()));
  ok(await waitFor(() => sent.length === 2), 'results sent back');
  ok((sent[1] || '').startsWith('[harness-bridge] results') && (sent[1].match(/```local-result/g) || []).length === 2 && sent[1].includes('updated src/app.js'), 'two local-result blocks with outputs');
  ok(/"redacted": 1/.test(sent[1] || '') && (sent[1] || '').includes('[REDACTED:openai-key]'), 'masked count passed to the model');
  pg.close();
  return log;
}

const all = [];
for (const [key, S] of Object.entries(SITES)) all.push(...(await runSite(key, S)));
process.exit(report(all) ? 0 : 1);
