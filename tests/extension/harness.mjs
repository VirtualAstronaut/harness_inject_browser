// Loads extension/content.js into a jsdom page with fake chrome.* APIs, so the
// content script can be exercised without a browser or a logged-in chat site.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { implForWrapper } = require('jsdom/lib/jsdom/living/generated/utils.js');

export const EXT_DIR = fileURLToPath(new URL('../../extension/', import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function checker(prefix = '') {
  const log = [];
  const ok = (cond, msg) => log.push(`${cond ? 'PASS' : 'FAIL'}  ${prefix}${msg}`);
  return { log, ok };
}

export function report(log) {
  console.log(log.join('\n'));
  const pass = log.every((l) => l.startsWith('PASS'));
  console.log(pass ? `\nALL PASS (${log.length})` : `\nFAILED: ${log.filter((l) => !l.startsWith('PASS')).length}`);
  return pass;
}

/**
 * Build a page and load the content script.
 * @param {object} o
 * @param {string} o.url        page URL (picks the site adapter)
 * @param {string} o.body       page HTML
 * @param {(payload, ctx) => object} o.reply  fake bridge: the app's reply for a payload
 * @param {boolean} o.quillPaste input handles synthetic paste (Gemini) instead of execCommand
 * @param {boolean} o.focused   document.hasFocus() result
 */
export async function makePage({ url, body, reply, quillPaste = false, focused = true }) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  const d = w.document;

  // Browser APIs jsdom lacks.
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
  });
  w.Element.prototype.scrollIntoView = () => {};
  w.DataTransfer = class { constructor() { this.d = {}; } setData(k, v) { this.d[k] = v; } getData(k) { return this.d[k]; } };
  w.ClipboardEvent = class extends w.Event { constructor(t, i) { super(t, i); this.clipboardData = i.clipboardData; } };
  d.hasFocus = () => focused;

  // Open every shadow root so tests can look inside the panel.
  const roots = [];
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function () { const r = attach.call(this, { mode: 'open' }); roots.push(r); return r; };

  // Trusted events: the content script ignores synthetic (untrusted) clicks, so
  // dispatch through jsdom's internals with isTrusted set.
  const trusted = (target, e) => { implForWrapper(e).isTrusted = true; implForWrapper(target)._dispatch(implForWrapper(e)); return e; };
  const click = (el) => trusted(el, new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const enter = (el) => trusted(el, new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  // Fake editor: paste (Quill) or execCommand('insertText') (ProseMirror) replaces the selection or appends.
  const input = d.querySelector('[contenteditable]');
  const insertAt = (text) => {
    const sel = w.getSelection();
    const all = sel.rangeCount && sel.getRangeAt(0).toString() === input.textContent && input.textContent;
    input.textContent = (all ? '' : input.textContent) + text;
  };
  const counts = { pastes: 0 };
  input.addEventListener('paste', (e) => {
    counts.pastes++;
    if (quillPaste) { insertAt(e.clipboardData.getData('text/plain')); e.preventDefault(); }
  });
  d.execCommand = (cmd, _ui, text) => (cmd === 'insertText' ? (insertAt(text), true) : false);

  // Fake chrome.* APIs.
  const listeners = [];
  const calls = [];
  const notifies = [];
  const emitProgress = (id, chunk) => listeners.forEach((l) => l({ kind: 'progress', id, stream: 'stdout', chunk }));
  w.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg.kind === 'protocol') return setTimeout(() => cb({ text: fs.readFileSync(EXT_DIR + 'protocol.md', 'utf8') }), 5);
        if (msg.kind?.startsWith('notify')) { notifies.push(msg); return cb?.({}); }
        setTimeout(() => {
          const p = msg.payload;
          calls.push({ ...p, t: Date.now() });
          cb(reply(p, { calls, emitProgress }));
        }, 20);
      },
      onMessage: { addListener: (l) => listeners.push(l) },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };

  // Run our own content script inside the jsdom window (test only).
  w.eval(fs.readFileSync(EXT_DIR + 'content.js', 'utf8'));
  await sleep(100);

  const panel = () => roots.map((r) => r.querySelector('.p')).find(Boolean);
  const card = () => panel()?.querySelector('.section:not(.live)');
  const button = (label, root = panel()) => [...(root?.querySelectorAll('button') || [])].find((b) => b.textContent === label);
  const clickCard = (label) => {
    const b = button(label, card());
    if (!b) throw new Error(`no "${label}" button in card: ${card()?.textContent}`);
    click(b);
  };
  const waitFor = async (fn, ms = 9000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); }
    return false;
  };

  return { dom, w, d, input, counts, calls, notifies, panel, card, button, click, clickCard, enter, waitFor, close: () => w.close() };
}
