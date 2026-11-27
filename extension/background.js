// Relays requests from the chat-site content scripts (Gemini, ChatGPT, Claude) to the native host, forwards
// live output ("progress") back to the tab, and shows macOS notifications.
// One native port per request: an open port also keeps this MV3 worker alive
// while the user is deciding on an approval.

const HOST = 'com.harness.bridge';
const ALLOWED_ORIGINS = new Set([
  'https://gemini.google.com',
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://claude.ai',
]);
const notifTabs = new Map(); // notification id -> { tabId, windowId }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!ALLOWED_ORIGINS.has(sender.origin)) {
    sendResponse({ status: 'error', error: `origin not allowed: ${sender.origin}` });
    return false;
  }
  const tab = sender.tab;

  if (msg?.kind === 'protocol') {
    fetch(chrome.runtime.getURL('protocol.md'))
      .then((r) => r.text())
      .then((text) => sendResponse({ text }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  if (msg?.kind === 'notify' && tab) {
    const id = `hb-${tab.id}`;
    notifTabs.set(id, { tabId: tab.id, windowId: tab.windowId });
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: msg.title || 'Harness Bridge',
      message: msg.message || 'Waiting for your approval',
      requireInteraction: true,
      priority: 2,
    });
    return false;
  }
  if (msg?.kind === 'notify-clear' && tab) {
    chrome.notifications.clear(`hb-${tab.id}`);
    return false;
  }

  if (msg?.kind !== 'bridge') return false;

  const payload = { ...msg.payload, source: new URL(sender.origin).host };
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    sendResponse({ status: 'error', error: String(e) });
    return false;
  }

  let answered = false;
  port.onMessage.addListener((reply) => {
    if (reply?.type === 'progress') {
      if (tab) chrome.tabs.sendMessage(tab.id, { kind: 'progress', ...reply }, { frameId: sender.frameId }).catch(() => {});
      return;
    }
    answered = true;
    sendResponse(reply);
    port.disconnect();
  });
  port.onDisconnect.addListener(() => {
    if (!answered) {
      sendResponse({
        id: payload.id,
        status: 'error',
        error: chrome.runtime.lastError?.message || 'native host disconnected',
      });
    }
  });
  port.postMessage(payload);
  return true; // async sendResponse
});

chrome.notifications.onClicked.addListener((id) => {
  const t = notifTabs.get(id);
  if (t) {
    chrome.tabs.update(t.tabId, { active: true }).catch(() => {});
    chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  }
  chrome.notifications.clear(id);
});
