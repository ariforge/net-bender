// Net Bender service worker.
//
// Interception is built on the Chrome DevTools Protocol "Fetch" domain via
// chrome.debugger: every matching request is paused at the request stage
// (before it is sent) and/or the response stage (before the page sees it).
// Paused items are pushed to the Intercept Console, which sends back edits
// and a verdict (forward or drop).

import {
  concatBase64,
  decodeBody,
  encodeBody,
  headerObjectToArray,
  sameHeaders,
  utf8ToBase64,
  withoutHeaders,
} from './lib/codec.js';

const PROTOCOL_VERSION = '1.3';
const CONSOLE_PATH = 'console/console.html';
const HISTORY_LIMIT = 300;
// Bodies larger than this are passed through untouched instead of being
// shipped to the editor (base64 length, roughly 4 MB of payload).
const MAX_EDITABLE_BODY = 5.5 * 1024 * 1024;

const RESOURCE_TYPES = [
  'Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch',
  'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping',
  'CSPViolationReport', 'Preflight', 'Other',
];

const DEFAULT_SETTINGS = {
  interceptRequests: true,
  interceptResponses: false,
  urlPatterns: ['*'],
  resourceTypes: ['Document', 'XHR', 'Fetch'],
};

let settings = { ...DEFAULT_SETTINGS };
const attached = new Set(); // tab ids we have a debugger session on
const pending = new Map(); // item id -> { item, rawResponseBody }
const ports = new Set(); // connected Intercept Consoles
let history = [];
let seq = 0;

const ready = init();

async function init() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  if (saved) settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...saved });

  // If the worker was restarted while sessions were live, re-adopt them.
  const { attachedTabs = [] } = await chrome.storage.session.get('attachedTabs');
  for (const tabId of attachedTabs) {
    try {
      await applyFetch(tabId);
      attached.add(tabId);
    } catch {
      // session is gone
    }
  }
  await persistAttached();
  await refreshBadges();
}

// ---------------------------------------------------------------------------
// CDP plumbing

function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function buildPatterns() {
  const stages = [];
  if (settings.interceptRequests) stages.push('Request');
  if (settings.interceptResponses) stages.push('Response');

  const urls = settings.urlPatterns.length ? settings.urlPatterns : ['*'];
  const allTypes = !settings.resourceTypes.length || settings.resourceTypes.length >= RESOURCE_TYPES.length;
  const types = allTypes ? [null] : settings.resourceTypes;

  const patterns = [];
  for (const requestStage of stages) {
    for (const urlPattern of urls) {
      for (const resourceType of types) {
        patterns.push(resourceType ? { urlPattern, resourceType, requestStage } : { urlPattern, requestStage });
      }
    }
  }
  return patterns;
}

async function applyFetch(tabId) {
  const patterns = buildPatterns();
  if (!patterns.length) return send(tabId, 'Fetch.disable');
  return send(tabId, 'Fetch.enable', { patterns });
}

async function continuePlain(tabId, requestId) {
  try {
    await send(tabId, 'Fetch.continueRequest', { requestId });
  } catch {
    // request was cancelled or the session went away
  }
}

function describeError(err) {
  const message = err?.message || String(err);
  if (/Invalid InterceptionId|Invalid state/i.test(message)) {
    return 'The request no longer exists (the page navigated away or cancelled it).';
  }
  return message;
}

// ---------------------------------------------------------------------------
// Paused requests

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Fetch.requestPaused' || source.tabId == null) return;
  onRequestPaused(source.tabId, params).catch((err) => {
    console.warn('Net Bender: failed to handle paused request', err);
    continuePlain(source.tabId, params.requestId);
  });
});

function readPostData(request) {
  if (request.postDataEntries?.length) {
    return decodeBody(concatBase64(request.postDataEntries.map((e) => e.bytes || '')));
  }
  if (request.postData != null) return { body: request.postData, bodyEncoding: 'utf8' };
  return { body: '', bodyEncoding: 'utf8' };
}

async function onRequestPaused(tabId, params) {
  await ready;
  const isResponse = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
  const stageEnabled = isResponse ? settings.interceptResponses : settings.interceptRequests;

  // Nobody is watching, the stage was just switched off, or the response
  // failed at the network level: let it through untouched.
  if (!ports.size || !stageEnabled || params.responseErrorReason) {
    return continuePlain(tabId, params.requestId);
  }

  const req = params.request;
  const postData = readPostData(req);
  const item = {
    id: `nb-${++seq}`,
    tabId,
    requestId: params.requestId,
    stage: isResponse ? 'response' : 'request',
    resourceType: params.resourceType,
    time: Date.now(),
    request: {
      method: req.method,
      url: req.url,
      headers: headerObjectToArray(req.headers),
      ...postData,
      bodyUnavailable: req.hasPostData && !req.postData && !req.postDataEntries?.length,
    },
    response: null,
  };
  const entry = { item, rawResponseBody: '' };

  if (isResponse) {
    const status = params.responseStatusCode;
    let raw = '';
    let bodyError = null;
    if (status >= 300 && status < 400 && status !== 304) {
      bodyError = 'Redirect responses have no body.';
    } else {
      try {
        const res = await send(tabId, 'Fetch.getResponseBody', { requestId: params.requestId });
        raw = res.base64Encoded ? res.body : utf8ToBase64(res.body);
      } catch (err) {
        bodyError = `Body unavailable: ${describeError(err)}`;
      }
    }
    entry.rawResponseBody = raw;

    const tooLarge = raw.length > MAX_EDITABLE_BODY;
    if (tooLarge) {
      const mb = ((raw.length * 3) / 4 / 1024 / 1024).toFixed(1);
      bodyError = `Body is ${mb} MB, too large to edit. It will be passed through unchanged.`;
    }
    item.response = {
      status,
      statusText: params.responseStatusText || '',
      headers: params.responseHeaders || [],
      ...(tooLarge ? { body: '', bodyEncoding: 'utf8' } : decodeBody(raw)),
      bodyError,
    };
  }

  pending.set(item.id, entry);
  broadcast({ type: 'paused', item });
  refreshBadges();
}

async function forwardRequest(entry, edits) {
  const { item } = entry;
  const orig = item.request;
  const params = { requestId: item.requestId };

  if (edits) {
    if (edits.url && edits.url !== orig.url) params.url = edits.url;
    if (edits.method && edits.method !== orig.method) params.method = edits.method;
    const bodyChanged = !orig.bodyUnavailable
      && (edits.body !== orig.body || edits.bodyEncoding !== orig.bodyEncoding);
    if (bodyChanged) params.postData = encodeBody(edits.body, edits.bodyEncoding);
    // Chrome recomputes Content-Length from the (possibly new) body.
    if (!sameHeaders(edits.headers, orig.headers)) {
      params.headers = withoutHeaders(edits.headers, ['content-length']);
    }
  }

  await send(item.tabId, 'Fetch.continueRequest', params);
  return Object.keys(params).length > 1;
}

async function forwardResponse(entry, edits) {
  const { item } = entry;
  const orig = item.response;
  const plain = () => send(item.tabId, 'Fetch.continueRequest', { requestId: item.requestId });
  if (!edits) {
    await plain();
    return false;
  }

  const status = Number(edits.status);
  const statusChanged = status !== orig.status || edits.statusText !== orig.statusText;
  const headersChanged = !sameHeaders(edits.headers, orig.headers);
  const bodyChanged = !orig.bodyError
    && (edits.body !== orig.body || edits.bodyEncoding !== orig.bodyEncoding);
  if (!statusChanged && !headersChanged && !bodyChanged) {
    await plain();
    return false;
  }
  if (!Number.isInteger(status) || status < 100 || status > 999) {
    throw new Error(`Invalid status code "${edits.status}".`);
  }

  // getResponseBody hands us the decoded payload, so encoding/length headers
  // from the origin no longer describe what we send to the page.
  await send(item.tabId, 'Fetch.fulfillRequest', {
    requestId: item.requestId,
    responseCode: status,
    responsePhrase: edits.statusText || undefined,
    responseHeaders: withoutHeaders(edits.headers, ['content-length', 'content-encoding', 'transfer-encoding']),
    body: bodyChanged ? encodeBody(edits.body, edits.bodyEncoding) : entry.rawResponseBody,
  });
  return true;
}

async function forward(id, edits) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  try {
    const fn = entry.item.stage === 'request' ? forwardRequest : forwardResponse;
    const modified = await fn(entry, edits);
    record(entry.item, modified ? 'modified' : 'forwarded', edits);
  } catch (err) {
    record(entry.item, 'error', edits, describeError(err));
  } finally {
    broadcast({ type: 'resolved', id });
    refreshBadges();
  }
}

async function drop(id) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  try {
    await send(entry.item.tabId, 'Fetch.failRequest', { requestId: entry.item.requestId, errorReason: 'Aborted' });
    record(entry.item, 'dropped');
  } catch (err) {
    record(entry.item, 'error', null, describeError(err));
  } finally {
    broadcast({ type: 'resolved', id });
    refreshBadges();
  }
}

function forwardWhere(predicate) {
  const ids = [...pending.values()].filter((e) => predicate(e.item)).map((e) => e.item.id);
  return Promise.all(ids.map((id) => forward(id)));
}

function dropWhere(predicate) {
  const ids = [...pending.values()].filter((e) => predicate(e.item)).map((e) => e.item.id);
  return Promise.all(ids.map((id) => drop(id)));
}

function record(item, action, edits, error) {
  const status = item.stage === 'response'
    ? (edits && action === 'modified' ? Number(edits.status) : item.response.status)
    : null;
  const entry = {
    id: item.id,
    time: Date.now(),
    tabId: item.tabId,
    stage: item.stage,
    resourceType: item.resourceType,
    method: edits?.method || item.request.method,
    url: (item.stage === 'request' && edits?.url) || item.request.url,
    status,
    action,
    error: error || null,
  };
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  broadcast({ type: 'history', entry });
}

// ---------------------------------------------------------------------------
// Sessions

async function persistAttached() {
  await chrome.storage.session.set({ attachedTabs: [...attached] });
}

async function describeAttached() {
  const targets = await chrome.debugger.getTargets();
  return [...attached].map((tabId) => {
    const t = targets.find((x) => x.tabId === tabId);
    return { tabId, title: t?.title || `Tab ${tabId}`, url: t?.url || '' };
  });
}

async function attachTab(tabId) {
  await ready;
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (err) {
    // After a worker restart we may still own the session; probe it.
    if (!/already attached/i.test(err.message)) throw err;
    try {
      await applyFetch(tabId);
    } catch {
      throw new Error('Another debugger is already attached to this tab. Close it and try again.');
    }
  }
  try {
    await applyFetch(tabId);
  } catch (err) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw err;
  }
  attached.add(tabId);
  await persistAttached();
  await broadcastState();
  refreshBadges();
}

async function detachTab(tabId) {
  await ready;
  await forwardWhere((item) => item.tabId === tabId);
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await persistAttached();
  await broadcastState();
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

chrome.debugger.onDetach.addListener(async (source) => {
  const { tabId } = source;
  if (tabId == null || !attached.has(tabId)) return;
  attached.delete(tabId);
  // Chrome releases the paused requests itself when the session ends.
  for (const [id, entry] of pending) {
    if (entry.item.tabId === tabId) {
      pending.delete(id);
      broadcast({ type: 'resolved', id });
    }
  }
  await persistAttached();
  await broadcastState();
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (attached.has(tabId) && (info.status || info.title)) {
    refreshBadges();
    if (info.title || info.status === 'complete') broadcastState();
  }
});

// ---------------------------------------------------------------------------
// Settings

function sanitizeSettings(s) {
  const urlPatterns = (Array.isArray(s.urlPatterns) ? s.urlPatterns : [])
    .map((p) => String(p).trim())
    .filter(Boolean);
  const resourceTypes = (Array.isArray(s.resourceTypes) ? s.resourceTypes : [])
    .filter((t) => RESOURCE_TYPES.includes(t));
  return {
    interceptRequests: !!s.interceptRequests,
    interceptResponses: !!s.interceptResponses,
    urlPatterns: urlPatterns.length ? urlPatterns : ['*'],
    resourceTypes,
  };
}

async function updateSettings(partial) {
  await ready;
  settings = sanitizeSettings({ ...settings, ...partial });
  await chrome.storage.local.set({ settings });
  await Promise.all([...attached].map((tabId) => applyFetch(tabId).catch(() => {})));
  // Release anything paused at a stage that is no longer intercepted.
  if (!settings.interceptRequests) forwardWhere((item) => item.stage === 'request');
  if (!settings.interceptResponses) forwardWhere((item) => item.stage === 'response');
  await broadcastState();
}

// ---------------------------------------------------------------------------
// UI surface

async function getState() {
  await ready;
  return {
    settings,
    resourceTypeOptions: RESOURCE_TYPES,
    attached: await describeAttached(),
    pending: [...pending.values()].map((e) => e.item),
    history,
    consoleOpen: ports.size > 0,
  };
}

async function broadcastState() {
  if (!ports.size) return;
  broadcast({
    type: 'state',
    settings,
    attached: await describeAttached(),
  });
}

function broadcast(msg) {
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(port);
    }
  }
}

async function refreshBadges() {
  for (const tabId of attached) {
    let count = 0;
    for (const e of pending.values()) if (e.item.tabId === tabId) count++;
    chrome.action.setBadgeBackgroundColor({ tabId, color: count ? '#F97316' : '#7C3AED' }).catch(() => {});
    chrome.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 999)) : 'ON' }).catch(() => {});
  }
}

async function openConsole() {
  const url = chrome.runtime.getURL(CONSOLE_PATH);
  const [ctx] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (ctx && ctx.tabId >= 0) {
    await chrome.tabs.update(ctx.tabId, { active: true });
    await chrome.windows.update(ctx.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

async function handleCommand(msg) {
  switch (msg.type) {
    case 'getState': return getState();
    case 'attach': return attachTab(msg.tabId);
    case 'detach': return detachTab(msg.tabId);
    case 'setSettings': return updateSettings(msg.settings);
    case 'forward': return forward(msg.id, msg.edits);
    case 'drop': return drop(msg.id);
    case 'forwardAll': return forwardWhere(() => true);
    case 'dropAll': return dropWhere(() => true);
    case 'clearHistory':
      history = [];
      return null;
    case 'openConsole': return openConsole();
    case 'ping': return null;
    default: throw new Error(`Unknown command: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handleCommand(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'console' || port.sender?.id !== chrome.runtime.id) return;
  ports.add(port);
  port.onMessage.addListener((msg) => {
    handleCommand(msg).then(
      (result) => msg.replyId && port.postMessage({ type: 'reply', replyId: msg.replyId, ok: true, result }),
      (err) => msg.replyId && port.postMessage({ type: 'reply', replyId: msg.replyId, ok: false, error: err?.message || String(err) }),
    );
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    // With no console left to answer, release everything so tabs don't hang.
    if (!ports.size) forwardWhere(() => true);
  });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') openConsole();
});
