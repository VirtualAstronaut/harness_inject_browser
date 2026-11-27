// Full Gemini flow: trust prompt, live output, diff review, sandbox retry,
// notifications, and results sent back.

import { checker, esc, makePage, report } from './harness.mjs';

const { log, ok } = checker();

// The project the fake app reports; the test switches it mid-run (`harness-bridge OTHER`).
const proj = { path: '/Users/me/proj', name: 'proj' };
const reply = (p, { calls, emitProgress }) => {
  if (p.type === 'ping') return { type: 'pong', approval: 'auto', sandbox: true, auto_accept_edits: false, project: proj.path, project_name: proj.name };
  if (p.type === 'trust') return { type: 'trusted', added: p.paths, errors: [] };
  if (p.id === 'c1') {
    if (!p.trust_once && !calls.some((c) => c.type === 'trust')) return { type: 'result', id: 'c1', status: 'needs_trust', paths: ['/Users/me/other'] };
    for (const chunk of ['total 8\n', 'a.txt\n', 'b.txt\n']) emitProgress('c1', chunk);
    return { type: 'result', id: 'c1', status: 'ok', exit_code: 0, stdout: 'total 8\na.txt\nb.txt\n', sandbox: 'workspace-write', approval: 'policy' };
  }
  if (p.id === 'c2') {
    return p.approved
      ? { type: 'result', id: 'c2', status: 'ok', exit_code: 0, stdout: 'updated src/app.js (+1 -1 lines)', approval: 'inline' }
      : { type: 'result', id: 'c2', status: 'needs_approval', error: 'review the file changes', diff: '--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-port = 3000\n+port = 8080\n' };
  }
  if (p.id === 'c3') {
    return p.network
      ? { type: 'result', id: 'c3', status: 'ok', exit_code: 0, stdout: 'added 1 package', sandbox: 'workspace-write+network' }
      : { type: 'result', id: 'c3', status: 'ok', exit_code: 1, stderr: 'npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org', sandbox: 'workspace-write', sandbox_blocked: true };
  }
  return { status: 'error', error: 'unexpected' };
};

const pg = await makePage({
  url: 'https://gemini.google.com/app',
  body: `<div id="chat"></div><rich-textarea><div contenteditable="true" role="textbox"></div></rich-textarea><button aria-label="Send message">send</button>`,
  reply,
  quillPaste: true,
  focused: false, // background tab -> notifications
});
const { w, d, input, panel, card, button, click, clickCard, waitFor, calls, notifies } = pg;

// Fake Gemini: Send posts the message; the first one gets a reply with 3 actions.
const sent = [];
const chat = d.getElementById('chat');
const sendBtn = d.querySelector('button[aria-label="Send message"]');
sendBtn.addEventListener('click', () => {
  sent.push(input.textContent);
  input.textContent = '';
  const q = d.createElement('user-query');
  q.textContent = sent.at(-1).slice(0, 40);
  chat.append(q);
  if (sent.length === 1) {
    setTimeout(() => {
      const blocks = [
        { tool: 'local-exec', id: 'c1', cmd: 'ls -la', cwd: '/Users/me/other' },
        { tool: 'apply_patch', id: 'c2', path: 'src/app.js', edits: [{ old: 'port = 3000', new: 'port = 8080' }] },
        { tool: 'local-exec', id: 'c3', cmd: 'npm install left-pad' },
      ];
      const html = '<p>Sure.</p>' + blocks.map((b) => `<pre><code>${esc(JSON.stringify(b))}</code></pre>`).join('');
      chat.insertAdjacentHTML('beforeend', `<model-response>${html}</model-response>`);
    }, 200);
  }
});

await waitFor(() => panel()?.textContent.includes('Mode: Auto'), 2000);
ok(panel().textContent.includes('Mode: Auto · Sandbox on · Edits: review'), 'panel shows mode / sandbox / edits');

input.textContent = 'list my project files';
click(button('Add instructions'));
await waitFor(() => input.textContent.startsWith('[harness-bridge protocol]'));
ok(input.textContent.endsWith('list my project files') && sent.length === 0, 'Add instructions fills the box without sending');
click(sendBtn);
ok(sent[0]?.startsWith('[harness-bridge protocol]'), 'first message sent with instructions on top');

ok(await waitFor(() => card()?.classList.contains('on') && card().textContent.includes('Trust this folder')), 'trust card for a folder outside the project');
ok(notifies.some((n) => n.kind === 'notify'), 'notification sent while the tab is unfocused');
const seenLive = [];
new w.MutationObserver(() => {
  const live = panel().querySelector('.live');
  seenLive.push(`${live.classList.contains('on') ? 'ON:' : 'off:'}${live.querySelector('pre').textContent}|${live.querySelector('.title').textContent}`);
}).observe(panel(), { subtree: true, childList: true, characterData: true, attributes: true });
clickCard('Trust folder');
ok(await waitFor(() => seenLive.some((t) => t.startsWith('ON:') && t.includes('b.txt') && t.includes('Running: ls -la'))), 'live output streamed into the panel');

ok(await waitFor(() => card()?.classList.contains('on') && card().textContent.includes('Review changes to src/app.js')), 'diff review card');
ok(card().querySelector('.d-add')?.textContent.includes('port = 8080') && card().querySelector('.d-del')?.textContent.includes('port = 3000'), 'diff lines coloured');
clickCard('Apply');

ok(await waitFor(() => card()?.classList.contains('on') && card().textContent.includes('sandbox blocked')), 'sandbox-blocked card');
// The user switches project in Terminal before the batch finishes.
proj.path = '/Users/me/other-proj';
proj.name = 'other-proj';
clickCard('Retry with network');
ok(await waitFor(() => calls.some((c) => c.id === 'c3' && c.network && c.approved)), 'retry sent with network');

ok(await waitFor(() => sent.length === 2), 'results sent automatically');
const res = sent[1] || '';
ok(res.startsWith('[harness-bridge] results') && (res.match(/```local-result/g) || []).length === 3, 'three local-result blocks');
ok(res.includes('b.txt') && res.includes('updated src/app.js') && res.includes('added 1 package'), 'results contain all three outputs');
ok(notifies.at(-1)?.kind === 'notify-clear', 'notification cleared after the last prompt');
ok(!res.includes('[harness-bridge protocol]'), 'instructions not added to later messages');
ok(res.startsWith('[harness-bridge] results:\n\nProject folder: /Users/me/other-proj\n'), 'results start with the current project folder (after a switch)');
ok(await waitFor(() => panel().textContent.includes('📁 other-proj') && panel().textContent.includes('/Users/me/other-proj · the model is told')), 'panel shows the switched project and its full path');

pg.close();
process.exit(report(log) ? 0 : 1);
