const $ = (id) => document.getElementById(id);

async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'No response from the extension.');
  return res.result;
}

function isAttachable(url) {
  return /^(https?|file):/i.test(url || '') || url === 'about:blank';
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

let tabId = null;

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  const [state, targets] = await Promise.all([call('getState'), chrome.debugger.getTargets()]);
  const target = targets.find((t) => t.tabId === tabId);
  const isAttached = state.attached.some((t) => t.tabId === tabId);

  $('tab-title').textContent = target?.title || 'Current tab';
  $('tab-url').textContent = target?.url || '';
  $('tab-url').title = target?.url || '';
  $('tab-dot').classList.toggle('on', isAttached);

  const btn = $('attach');
  btn.textContent = isAttached ? 'Stop intercepting' : 'Intercept this tab';
  btn.classList.toggle('primary', !isAttached);
  btn.classList.toggle('stop', isAttached);
  btn.dataset.attached = String(isAttached);
  const attachable = isAttached || isAttachable(target?.url);
  btn.disabled = tabId == null || !attachable;
  if (!attachable && target) showError('Chrome does not allow extensions to intercept this page.');

  $('toggle-req').checked = state.settings.interceptRequests;
  $('toggle-res').checked = state.settings.interceptResponses;

  const tabs = state.attached.length;
  const pending = state.pending.length;
  $('summary').textContent = `${tabs} tab${tabs === 1 ? '' : 's'} attached · ${pending} pending`;
}

$('attach').addEventListener('click', async () => {
  showError('');
  try {
    if ($('attach').dataset.attached === 'true') {
      await call('detach', { tabId });
      await render();
    } else {
      await call('attach', { tabId });
      // Paused traffic needs the console to be answered, so bring it up.
      await call('openConsole');
      window.close();
    }
  } catch (err) {
    showError(err.message);
  }
});

$('open-console').addEventListener('click', async () => {
  await call('openConsole');
  window.close();
});

for (const [id, key] of [['toggle-req', 'interceptRequests'], ['toggle-res', 'interceptResponses']]) {
  $(id).addEventListener('change', (e) => {
    call('setSettings', { settings: { [key]: e.target.checked } }).catch((err) => showError(err.message));
  });
}

render().catch((err) => showError(err.message));
