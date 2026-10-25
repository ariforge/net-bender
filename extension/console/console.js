import { headersToText, textToHeaders } from '../lib/codec.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  resourceTypeOptions: [],
  attached: [],
  pending: [],
  history: [],
  selectedId: null,
  drafts: new Map(), // item id -> form snapshot
  filtersDirty: false,
  view: 'intercept',
};

// ---------------------------------------------------------------------------
// Messaging with the service worker

let port = null;
let replySeq = 0;
const replies = new Map();

function connect() {
  port = chrome.runtime.connect({ name: 'console' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    for (const r of replies.values()) r.reject(new Error('Lost connection to the extension.'));
    replies.clear();
    setTimeout(() => {
      connect();
      loadState();
    }, 300);
  });
}

function call(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!port) connect();
    const replyId = ++replySeq;
    replies.set(replyId, { resolve, reject });
    port.postMessage({ type, replyId, ...payload });
  });
}

function onMessage(msg) {
  switch (msg.type) {
    case 'reply': {
      const r = replies.get(msg.replyId);
      if (!r) return;
      replies.delete(msg.replyId);
      if (msg.ok) r.resolve(msg.result);
      else r.reject(new Error(msg.error));
      return;
    }
    case 'paused':
      state.pending.push(msg.item);
      if (!state.selectedId) state.selectedId = msg.item.id;
      renderQueue();
      if (state.selectedId === msg.item.id) renderEditor();
      return;
    case 'resolved':
      removePending(msg.id);
      return;
    case 'history':
      state.history.unshift(msg.entry);
      if (msg.entry.action === 'error') toast(msg.entry.error, true);
      renderHistory();
      return;
    case 'state':
      state.settings = msg.settings;
      state.attached = msg.attached;
      renderSettings();
      renderTargets();
      // Don't re-render a form the user may be typing in.
      if (!currentItem()) renderEditor();
      return;
  }
}

async function loadState() {
  const s = await call('getState');
  Object.assign(state, {
    settings: s.settings,
    resourceTypeOptions: s.resourceTypeOptions,
    attached: s.attached,
    pending: s.pending,
    history: s.history,
  });
  if (!state.pending.some((i) => i.id === state.selectedId)) state.selectedId = state.pending[0]?.id || null;
  state.filtersDirty = false;
  renderSettings();
  renderTargets();
  renderQueue();
  renderEditor();
  renderHistory();
}

function removePending(id) {
  const idx = state.pending.findIndex((i) => i.id === id);
  if (idx === -1) return;
  state.pending.splice(idx, 1);
  state.drafts.delete(id);
  if (state.selectedId === id) {
    const next = state.pending[Math.min(idx, state.pending.length - 1)];
    state.selectedId = next?.id || null;
    renderEditor();
  }
  renderQueue();
}

// ---------------------------------------------------------------------------
// Settings, filters and targets

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('toggle-req').checked = s.interceptRequests;
  $('toggle-res').checked = s.interceptResponses;
  if (!state.filtersDirty) {
    $('url-patterns').value = s.urlPatterns.join('\n');
    renderChips(s.resourceTypes);
  }
  $('apply-filters').disabled = !state.filtersDirty;
}

function renderChips(selected) {
  const box = $('resource-types');
  box.replaceChildren(...state.resourceTypeOptions.map((type) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = type;
    b.dataset.type = type;
    b.setAttribute('aria-pressed', String(selected.includes(type)));
    return b;
  }));
}

function selectedChips() {
  return [...$('resource-types').querySelectorAll('.chip[aria-pressed="true"]')].map((b) => b.dataset.type);
}

function markFiltersDirty() {
  state.filtersDirty = true;
  $('apply-filters').disabled = false;
  $('filters-saved').hidden = true;
}

async function applyFilters() {
  const urlPatterns = $('url-patterns').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const resourceTypes = selectedChips();
  if (!resourceTypes.length) {
    toast('Select at least one resource type.', true);
    return;
  }
  try {
    state.filtersDirty = false;
    await call('setSettings', { settings: { urlPatterns, resourceTypes } });
    $('filters-saved').hidden = false;
    setTimeout(() => { $('filters-saved').hidden = true; }, 1500);
  } catch (err) {
    state.filtersDirty = true;
    toast(err.message, true);
  }
  renderSettings();
}

function renderTargets() {
  const list = $('targets');
  list.replaceChildren(...state.attached.map((t) => {
    const li = document.createElement('li');
    li.className = 'target';
    li.innerHTML = `
      <span class="dot on"></span>
      <div class="target-text">
        <div class="target-title ellipsis"></div>
        <div class="target-url ellipsis"></div>
      </div>
      <button class="ghost" title="Stop intercepting this tab">Detach</button>`;
    li.querySelector('.target-title').textContent = t.title;
    li.querySelector('.target-url').textContent = t.url;
    li.querySelector('.target-url').title = t.url;
    li.querySelector('button').addEventListener('click', () => {
      call('detach', { tabId: t.tabId }).catch((err) => toast(err.message, true));
    });
    return li;
  }));
  $('targets-empty').hidden = state.attached.length > 0;
  refreshTabPicker();
}

function isAttachable(url) {
  return /^(https?|file):/i.test(url) || url === 'about:blank';
}

let pickerTimer = null;
function refreshTabPicker() {
  clearTimeout(pickerTimer);
  pickerTimer = setTimeout(async () => {
    const attachedIds = new Set(state.attached.map((t) => t.tabId));
    const targets = (await chrome.debugger.getTargets())
      .filter((t) => t.type === 'page' && t.tabId != null && !attachedIds.has(t.tabId) && isAttachable(t.url));
    const picker = $('tab-picker');
    const prev = picker.value;
    picker.replaceChildren(...targets.map((t) => {
      const o = document.createElement('option');
      o.value = String(t.tabId);
      o.textContent = t.title || t.url;
      o.title = t.url;
      return o;
    }));
    if (!targets.length) {
      const o = document.createElement('option');
      o.textContent = 'No attachable tabs open';
      o.value = '';
      picker.append(o);
    }
    if (targets.some((t) => String(t.tabId) === prev)) picker.value = prev;
    picker.disabled = !targets.length;
    $('attach-btn').disabled = !targets.length;
  }, 100);
}

// ---------------------------------------------------------------------------
// Queue

function splitUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host || u.protocol, path: (u.pathname + u.search) || '/' };
  } catch {
    return { host: url, path: '' };
  }
}

function renderQueue() {
  const list = $('queue');
  list.replaceChildren(...state.pending.map((item) => {
    const { host, path } = splitUrl(item.request.url);
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.classList.toggle('selected', item.id === state.selectedId);
    li.classList.toggle('edited', isModified(item, state.drafts.get(item.id)));
    li.dataset.id = item.id;
    li.innerHTML = `
      <span class="badge"></span>
      <div class="q-line1"><span class="q-method"></span><span class="q-host ellipsis"></span></div>
      <span class="q-status"></span>
      <div class="q-path ellipsis"></div>`;
    const badge = li.querySelector('.badge');
    badge.classList.add(item.stage === 'request' ? 'req' : 'res');
    badge.textContent = item.stage === 'request' ? 'REQ' : 'RES';
    li.querySelector('.q-method').textContent = item.request.method;
    li.querySelector('.q-host').textContent = host;
    li.querySelector('.q-status').textContent = item.response ? item.response.status : '';
    li.querySelector('.q-path').textContent = path;
    li.title = item.request.url;
    return li;
  }));
  const n = state.pending.length;
  $('queue-empty').hidden = n > 0;
  $('tab-count').textContent = n;
  $('tab-count').classList.toggle('live', n > 0);
  $('pending-pill').textContent = `${n} pending`;
  $('pending-pill').classList.toggle('live', n > 0);
  $('forward-all').disabled = !n;
  $('drop-all').disabled = !n;
  document.title = n ? `(${n}) Net Bender` : 'Net Bender - Intercept Console';
}

function selectItem(id) {
  if (!id || id === state.selectedId) return;
  state.selectedId = id;
  renderQueue();
  renderEditor();
  $('queue').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

function moveSelection(delta) {
  const idx = state.pending.findIndex((i) => i.id === state.selectedId);
  const next = state.pending[idx + delta];
  if (next) selectItem(next.id);
}

// ---------------------------------------------------------------------------
// Editor

function currentItem() {
  return state.pending.find((i) => i.id === state.selectedId) || null;
}

function originalForm(item) {
  if (item.stage === 'request') {
    return {
      method: item.request.method,
      url: item.request.url,
      headers: headersToText(item.request.headers),
      body: item.request.body,
      bodyEncoding: item.request.bodyEncoding,
    };
  }
  return {
    status: String(item.response.status),
    statusText: item.response.statusText,
    headers: headersToText(item.response.headers),
    body: item.response.body,
    bodyEncoding: item.response.bodyEncoding,
  };
}

function readForm(item) {
  const base = {
    headers: $('ed-headers').value,
    body: $('ed-body').value,
    bodyEncoding: originalForm(item).bodyEncoding,
  };
  if (item.stage === 'request') {
    return { ...base, method: $('ed-method').value.trim().toUpperCase(), url: $('ed-url').value.trim() };
  }
  return { ...base, status: $('ed-status').value.trim(), statusText: $('ed-status-text').value };
}

function isModified(item, form) {
  if (!form) return false;
  const orig = originalForm(item);
  return Object.keys(orig).some((k) => orig[k] !== form[k]);
}

function emptyEditorText() {
  const s = state.settings;
  if (!state.attached.length) return 'Attach a tab from the sidebar (or click the toolbar icon on any page) to start intercepting.';
  if (s && !s.interceptRequests && !s.interceptResponses) return 'Interception is paused. Turn on "Intercept requests" or "Intercept responses" above.';
  const n = state.attached.length;
  return `Listening on ${n} tab${n > 1 ? 's' : ''}. Matching traffic will pause here so you can edit it.`;
}

function renderEditor() {
  const item = currentItem();
  $('editor').hidden = !item;
  $('editor-empty').hidden = !!item;
  if (!item) {
    $('editor-empty-text').textContent = emptyEditorText();
    return;
  }

  const form = state.drafts.get(item.id) || originalForm(item);
  const isReq = item.stage === 'request';
  const tab = state.attached.find((t) => t.tabId === item.tabId);

  $('ed-stage').textContent = isReq ? 'Request' : 'Response';
  $('ed-stage').className = `badge ${isReq ? 'req' : 'res'}`;
  $('ed-type').textContent = item.resourceType || 'Other';
  $('ed-tab').textContent = tab ? `in ${tab.title}` : '';
  $('ed-request-line').hidden = !isReq;
  $('ed-response-line').hidden = isReq;

  if (isReq) {
    $('ed-method').value = form.method;
    $('ed-url').value = form.url;
  } else {
    $('ed-req-summary').textContent = `${item.request.method} ${item.request.url}`;
    $('ed-req-summary').title = item.request.url;
    $('ed-status').value = form.status;
    $('ed-status-text').value = form.statusText;
  }
  $('ed-headers').value = form.headers;
  $('ed-body').value = form.body;

  const source = isReq ? item.request : item.response;
  let note = '';
  let bodyLocked = false;
  if (isReq && source.bodyUnavailable) {
    note = 'Chrome did not expose this request body (it may be a large upload or a stream). It will be sent unchanged.';
    bodyLocked = true;
  } else if (!isReq && source.bodyError) {
    note = source.bodyError;
    bodyLocked = true;
  } else if (source.bodyEncoding === 'base64') {
    note = 'Binary body shown as base64. Edits must stay valid base64.';
  }
  $('ed-body-note').textContent = note;
  $('ed-body-note').hidden = !note;
  $('ed-body').disabled = bodyLocked;
  $('ed-body-enc').hidden = source.bodyEncoding !== 'base64';
  $('ed-pretty').hidden = bodyLocked || source.bodyEncoding === 'base64';
  $('ed-error').textContent = '';
  updateModified();
}

function updateModified() {
  const item = currentItem();
  if (!item) return;
  const modified = isModified(item, readForm(item));
  $('ed-modified').hidden = !modified;
  $('queue').querySelector(`[data-id="${item.id}"]`)?.classList.toggle('edited', modified);
}

function buildEdits(item, form) {
  const orig = originalForm(item);
  const source = isReqStage(item) ? item.request : item.response;
  const headers = form.headers === orig.headers ? source.headers : textToHeaders(form.headers);
  if (isReqStage(item)) {
    if (!form.method) throw new Error('Method cannot be empty.');
    try {
      new URL(form.url);
    } catch {
      throw new Error('URL is not valid.');
    }
    return { method: form.method, url: form.url, headers, body: form.body, bodyEncoding: form.bodyEncoding };
  }
  const status = Number(form.status);
  if (!Number.isInteger(status) || status < 100 || status > 999) throw new Error('Status code must be a number between 100 and 999.');
  return { status, statusText: form.statusText, headers, body: form.body, bodyEncoding: form.bodyEncoding };
}

function isReqStage(item) {
  return item.stage === 'request';
}

async function forwardSelected() {
  const item = currentItem();
  if (!item) return;
  const form = readForm(item);
  let edits = null;
  try {
    if (isModified(item, form)) edits = buildEdits(item, form);
  } catch (err) {
    $('ed-error').textContent = err.message;
    return;
  }
  call('forward', { id: item.id, edits }).catch((err) => toast(err.message, true));
}

function dropSelected() {
  const item = currentItem();
  if (!item) return;
  call('drop', { id: item.id }).catch((err) => toast(err.message, true));
}

function formatJson() {
  const ta = $('ed-body');
  try {
    ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    toast('Body is not valid JSON.', true);
  }
}

// ---------------------------------------------------------------------------
// History

function renderHistory() {
  const q = $('history-filter').value.trim().toLowerCase();
  const rows = state.history.filter((h) => !q
    || h.url.toLowerCase().includes(q)
    || h.method.toLowerCase().includes(q)
    || String(h.status ?? '').includes(q)
    || h.action.includes(q));
  $('history-body').replaceChildren(...rows.map((h) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="time"></td>
      <td><span class="badge"></span></td>
      <td><span class="badge"></span></td>
      <td class="mono"></td>
      <td class="mono"></td>
      <td class="url"></td>`;
    const [time, action, stage, method, status, url] = tr.children;
    time.textContent = new Date(h.time).toLocaleTimeString();
    action.firstElementChild.textContent = h.action;
    action.firstElementChild.classList.add(h.action);
    stage.firstElementChild.textContent = h.stage === 'request' ? 'REQ' : 'RES';
    stage.firstElementChild.classList.add(h.stage === 'request' ? 'req' : 'res');
    method.textContent = h.method;
    status.textContent = h.status ?? '';
    url.textContent = h.url;
    if (h.error) {
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = h.error;
      url.append(err);
    }
    return tr;
  }));
  $('history-empty').hidden = rows.length > 0;
  $('history-empty').querySelector('p').textContent = state.history.length
    ? 'No history entries match the filter.'
    : 'Items you forward or drop appear here.';
}

function showView(view) {
  state.view = view;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === view);
  $('view-intercept').hidden = view !== 'intercept';
  $('view-history').hidden = view !== 'history';
}

// ---------------------------------------------------------------------------
// Misc

let toastTimer = null;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2500);
}

function bind() {
  $('toggle-req').addEventListener('change', (e) => {
    call('setSettings', { settings: { interceptRequests: e.target.checked } }).catch((err) => toast(err.message, true));
  });
  $('toggle-res').addEventListener('change', (e) => {
    call('setSettings', { settings: { interceptResponses: e.target.checked } }).catch((err) => toast(err.message, true));
  });
  $('forward-all').addEventListener('click', () => call('forwardAll').catch((err) => toast(err.message, true)));
  $('drop-all').addEventListener('click', () => call('dropAll').catch((err) => toast(err.message, true)));

  $('attach-btn').addEventListener('click', async () => {
    const tabId = Number($('tab-picker').value);
    if (!tabId) return;
    try {
      await call('attach', { tabId });
      toast('Tab attached. Reload it to intercept its page load.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('url-patterns').addEventListener('input', markFiltersDirty);
  $('resource-types').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
    markFiltersDirty();
  });
  document.querySelector('.chip-actions').addEventListener('click', (e) => {
    const preset = e.target.closest('button')?.dataset.types;
    if (!preset) return;
    const sets = { all: state.resourceTypeOptions, api: ['XHR', 'Fetch'], none: [] };
    renderChips(sets[preset]);
    markFiltersDirty();
  });
  $('apply-filters').addEventListener('click', applyFilters);

  $('queue').addEventListener('click', (e) => selectItem(e.target.closest('.queue-item')?.dataset.id));

  $('editor').addEventListener('input', () => {
    const item = currentItem();
    if (!item) return;
    state.drafts.set(item.id, readForm(item));
    $('ed-error').textContent = '';
    updateModified();
  });
  $('editor').addEventListener('submit', (e) => {
    e.preventDefault();
    forwardSelected();
  });
  $('ed-drop').addEventListener('click', dropSelected);
  $('ed-reset').addEventListener('click', () => {
    state.drafts.delete(state.selectedId);
    renderEditor();
    renderQueue();
  });
  $('ed-pretty').addEventListener('click', formatJson);

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const view = e.target.closest('button')?.dataset.view;
    if (view) showView(view);
  });
  $('history-filter').addEventListener('input', renderHistory);
  $('history-clear').addEventListener('click', async () => {
    await call('clearHistory');
    state.history = [];
    renderHistory();
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (state.view !== 'intercept') return;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) dropSelected();
      else forwardSelected();
    } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  // Keep the tab picker fresh as tabs come and go.
  chrome.tabs.onCreated.addListener(refreshTabPicker);
  chrome.tabs.onRemoved.addListener(refreshTabPicker);
  chrome.tabs.onUpdated.addListener(refreshTabPicker);
  window.addEventListener('focus', refreshTabPicker);

  // Long-lived port traffic keeps the service worker awake while we wait for
  // the user to decide on a paused request.
  setInterval(() => port?.postMessage({ type: 'ping' }), 20_000);
}

bind();
connect();
loadState().catch((err) => toast(err.message, true));
