import { t, localizeDocument } from './i18n.js';
import { magneticVolume } from './volume-control.js';
import { createPopupClient } from './popup-client.js';
import { createSessionList } from './session-list.js';

localizeDocument();

const $ = id => document.getElementById(id);
const manifest = chrome.runtime.getManifest();
$('version').textContent = manifest.version_name || manifest.version;
// Edge measures action popups using intrinsic width. A viewport-relative width
// cap there can lock the popup at its tiny initial viewport. Reflow only the
// standalone tab view; keep the native action's established 390px width.
let inTab = true;
let currentTab, currentState;
let editingUntil = 0;
const client = createPopupClient({
  sendMessage: message => chrome.runtime.sendMessage(message),
  queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }),
  render, onError: showError,
});
const sessions = createSessionList($('sessions'), act);
const settingControls = document.querySelectorAll('#volume, [data-volume], #normalize, #auto-enable');
settingControls.forEach(control => { control.disabled = true; });
for (const id of ['normalize', 'auto-enable']) $(id).indeterminate = true;
$('volume-value').value = '—';
$('session-count').textContent = '…';
const discoveryMessage = `<p class="empty">${t('discovering')}</p>`;
$('sessions').innerHTML = discoveryMessage;
// Keep emergency stop available even when discovery or bootstrap is stalled.
$('stop-all').hidden = false;

function showError(error) {
  $('error-message').textContent = error.message;
  $('error').hidden = false;
  $('status').textContent = t('text_c274a6676b');
  $('stop-all').hidden = false;
}

function paintVolume(value) {
  $('volume').value = value;
  $('volume-value').value = value;
  $('volume').style.setProperty('--fill', `${value / 5}%`);
  document.querySelectorAll('[data-volume]').forEach(button => {
    const selected = Number(button.dataset.volume) === Number(value);
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function saveSettings(patch) {
  editingUntil = Date.now() + 1500;
  client.saveSettings(patch);
  if (patch.autoEnable === true) client.settled().then(() => inTab || act('AUTO_START'));
}

function render(state, { tab, busy }) {
  currentState = state; currentTab = tab;
  settingControls.forEach(control => { control.disabled = false; });
  for (const id of ['normalize', 'auto-enable']) $(id).indeterminate = false;
  if (Date.now() > editingUntil) {
    paintVolume(state.settings.volume);
    $('normalize').checked = state.settings.normalize;
    $('auto-enable').checked = state.settings.autoEnable;
  }
  const enabled = state.sessions.some(session => session.tabId === currentTab?.id);
  const supported = /^https?:\/\//i.test(currentTab?.url || '');
  const unavailable = state.unavailableTabs || [];
  const disconnected = supported && unavailable.some(page => page.tabId === currentTab?.id);
  const missingAudio = unavailable.some(page => page.audible);
  $('detection-hint').hidden = !disconnected && !missingAudio;
  $('detection-hint').textContent = disconnected
    ? t('text_b3c21847e5')
    : missingAudio ? t('text_1ceab61156') : '';
  document.querySelector('.current-card').hidden = !supported && !enabled && !disconnected;
  $('status').textContent = state.discoveryPending ? t('text_e1424fd122') : state.captureUnavailable ? t('text_190411f2af') : state.settings.autoEnable ? t('text_43acb3d3a2')
    : state.sessions.length ? t('text_09fcdba0f3', [state.sessions.length]) : t('text_b37bd8cdfa');
  $('current-title').textContent = currentTab?.title || t('text_f991f79fa5');
  const page = state.pages?.find(page => page.tabId === currentTab?.id);
  const failure = state.captureErrors?.[currentTab?.id];
  $('current-hint').textContent = state.captureUnavailable ? t('text_38c80359d0') : failure || (enabled
    ? t('text_abc49b6998')
    : page?.requiresCapture ? t('text_e7131d700f')
      : disconnected ? t('text_9907f70ce3')
        : supported ? t('text_4d8014ee0d') : t('text_656105bada'));
  $('toggle-current').textContent = enabled ? t('text_96d72cb112') : t('text_f2bed822b9');
  $('toggle-current').classList.toggle('enabled', enabled);
  $('toggle-current').disabled = busy || (!supported && !enabled);
  const pages = state.pages || state.sessions;
  $('session-count').textContent = state.discoveryPending ? '…' : pages.length;
  $('stop-all').hidden = !busy && !state.discoveryPending && !state.captureUnavailable && state.sessions.length === 0;
  $('stop-all').disabled = false;
  if (state.discoveryPending) $('sessions').innerHTML = discoveryMessage;
  else sessions.render(pages, state.settings, busy);
}

async function act(type, data) {
  $('error').hidden = true;
  await client.act(type, data);
  if (!inTab && type === 'TAB_CONTROL' && data.stopped === false && data.tabId === currentTab?.id) {
    await client.act('AUTO_START');
  }
}

let sliderPointer = false;
$('volume').addEventListener('pointerdown', () => { sliderPointer = true; });
window.addEventListener('pointerup', () => { sliderPointer = false; });
window.addEventListener('pointercancel', () => { sliderPointer = false; });
$('volume').addEventListener('input', event => {
  const volume = magneticVolume(Number(event.target.value), event instanceof PointerEvent || sliderPointer);
  paintVolume(volume);
  saveSettings({ volume });
});
document.querySelectorAll('[data-volume]').forEach(button => button.addEventListener('click', () => {
  const volume = Number(button.dataset.volume);
  paintVolume(volume);
  saveSettings({ volume });
}));
$('normalize').addEventListener('change', event => saveSettings({ normalize: event.target.checked }));
$('auto-enable').addEventListener('change', event => saveSettings({ autoEnable: event.target.checked }));
$('toggle-current').addEventListener('click', () => {
  const enabled = currentState.sessions.some(session => session.tabId === currentTab?.id);
  act(enabled ? 'STOP' : 'START', { tabId: currentTab?.id });
});
$('stop-all').addEventListener('click', () => act('STOP_ALL'));

$('retry').addEventListener('click', () => {
  $('error').hidden = true;
  client.refresh();
});
const timer = setInterval(() => client.refresh(), 600);
window.addEventListener('pagehide', () => { clearInterval(timer); client.dispose(); }, { once: true });
// Install polling and cleanup before any browser call. Settings do not depend
// on content-script inspections, offscreen startup, or getCurrent succeeding.
const initialSettings = client.loadSettings();
try {
  inTab = Boolean(await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error(t('text_83719d925a'))), 2000);
    chrome.tabs.getCurrent().then(resolve, reject).finally(() => clearTimeout(deadline));
  }));
  document.body.classList.toggle('in-tab', inTab);
} catch (error) { showError(error); }
await initialSettings;
await client.refresh();
// Opening the real action grants activeTab. A standalone extension tab does
// not: leave its explicit button available and surface browser denials.
if (!inTab) await act('AUTO_START');
