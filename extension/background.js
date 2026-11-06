import { t } from './i18n.js';
import { sanitizeSettings } from './settings.js';
import { sanitizeTabControl, effectiveSettings, aggregateFrames } from './tab-state.js';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
let queue = Promise.resolve();
const reports = new Map();
const documents = new Map();
const starts = new Map();
let captureEpoch = 0, configEpoch = 0, creating, closing, stateRead;
let lastSessions = [];

// Deadlines abandon replies; only AbortController checkpoints and the audio
// owner's STOP protocol cancel capture work. Read-only late replies are ignored.
function external(operation, ms = 800, signal) {
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value);
    };
    const abort = () => finish(reject, signal.reason);
    const timer = setTimeout(() => finish(reject, Error(t('text_3d7d574177'))), ms);
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function cancelStarts(tabId) {
  captureEpoch++;
  for (const [id, job] of starts) if (tabId === undefined || id === tabId) {
    job.cancelled = true;
    job.controller.abort(Error(t('text_022246cabd')));
  }
}

function documentKey(sender) {
  return `${sender.tab.id}:${sender.frameId || 0}`;
}

function isCurrentDocument(sender) {
  const current = documents.get(documentKey(sender));
  return !current || current === (sender.documentId || sender.url);
}

async function controls() {
  return (await chrome.storage.session.get('tabControls')).tabControls || {};
}

async function pageSettings(tabId) {
  const tab = await external(chrome.tabs.get(tabId));
  return effectiveSettings(await settings(), sanitizeTabControl((await controls())[tabId]), tab.mutedInfo?.muted);
}

function serialized(task) {
  const next = queue.then(task);
  queue = next.catch(() => {});
  return next;
}

async function hasOffscreen() {
  return (await external(chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL],
  }))).length > 0;
}

async function ensureOffscreen() {
  if (closing) await external(closing, 1500);
  if (await hasOffscreen()) return;
  if (!creating) {
    const operation = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['USER_MEDIA'],
      justification: t('text_22067d1c43'),
    });
    creating = operation;
    operation.then(async () => {
      if (creating === operation) creating = undefined;
      // createDocument itself is not cancellable. Retire a document created
      // after all requesting starts were cancelled or timed out.
      if (![...starts.values()].some(job => !job.controller.signal.aborted)) await closeIfIdle();
    }, () => { if (creating === operation) creating = undefined; }).catch(console.error);
  }
  await external(creating, 1500);
}

let offscreenMessages;
function audioMessages() {
  return offscreenMessages ||= Object.fromEntries(["documentLanguage", "text_022246cabd", "text_10bfbf41cb", "text_3d291aa5b5", "text_44c76c2546", "text_62d4d18bee", "text_78f19f242c", "text_7c63175b61", "text_a60dd21571", "text_b028661ebd", "text_b468dc2e6e", "text_cb5fbb4c65", "text_ec9a458952", "text_b626a2480c"].map(key => [key, t(key, ['$1'])]));
}

async function audio(type, data = {}, signal) {
  const response = await external(chrome.runtime.sendMessage({ target: 'offscreen', type, ...data, i18n: audioMessages() }), type === 'START' ? 6000 : 800, signal);
  if (!response?.ok) throw new Error(response?.error || t('text_a3477fe337'));
  return response.data;
}

async function capturedSessions() {
  lastSessions = await hasOffscreen() ? await audio('STATE') : [];
  return lastSessions;
}

async function closeOffscreen() {
  if (!closing) {
    const operation = chrome.offscreen.closeDocument();
    closing = operation;
    operation.finally(() => { if (closing === operation) closing = undefined; }).catch(() => {});
  }
  try { await external(closing, 1500); }
  catch (error) {
    // Another stop/owner failure may have closed the same document meanwhile.
    if (await hasOffscreen()) throw error;
  }
  lastSessions = [];
}

async function closeIfIdle() {
  if ([...starts.values()].some(job => !job.controller.signal.aborted)) return;
  if (!(await audio('STATE')).length && (await audio('IDLE')) !== false) await closeOffscreen();
}

async function stopCapture(type, tabId) {
  try {
    if (!(await hasOffscreen())) return;
    await audio(type, { tabId });
    await closeIfIdle();
  } catch (error) {
    // Closing the resource owner releases native suppression even if messaging
    // is broken. This emergency fallback can also stop other captured tabs.
    await closeOffscreen();
  }
}

async function captureError(tabId, error) {
  await serialized(async () => {
    const errors = (await chrome.storage.session.get('captureErrors')).captureErrors || {};
    if (error) errors[tabId] = String(error).slice(0, 300);
    else delete errors[tabId];
    await chrome.storage.session.set({ captureErrors: errors });
  });
}

async function settings() {
  return sanitizeSettings((await chrome.storage.local.get('settings')).settings);
}

async function sendPage(tabId, captured, value) {
  // Restricted pages and tabs opened before installation may have no receiver.
  await external(chrome.tabs.sendMessage(tabId, {
    target: 'automatic', captured, settings: value || await pageSettings(tabId),
  })).catch(() => {});
}

async function syncPages(sessions) {
  const epoch = configEpoch;
  const tabs = await external(chrome.tabs.query({}));
  const value = await settings();
  const overrides = await controls();
  const captured = new Set(sessions.map(session => session.tabId));
  for (const [tabId, job] of starts) if (!job.controller.signal.aborted) captured.add(tabId);
  if (epoch !== configEpoch) return;
  await Promise.all(tabs.map(async tab => {
    const next = effectiveSettings(value, sanitizeTabControl(overrides[tab.id]), tab.mutedInfo?.muted);
    await sendPage(tab.id, captured.has(tab.id), next);
    // A delayed acknowledgement must not apply an old nonzero setting after
    // the user has selected zero or muted the tab in a newer update.
    if (epoch === configEpoch && captured.has(tab.id)) await audio('TAB_SETTINGS', { tabId: tab.id, settings: next });
  }));
}

async function updateBadge(sessions) {
  const stored = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
  const value = await settings();
  const overrides = await controls();
  const ids = new Set(sessions.map(session => session.tabId));
  if (value.autoEnable) {
    for (const [id, frames] of Object.entries(stored)) {
      if (!sanitizeTabControl(overrides[id]).stopped && Object.values(frames).some(frame => frame.count > 0)) ids.add(Number(id));
    }
  }
  await external(chrome.action.setBadgeText({ text: '' }));
  await external(chrome.action.setTitle({ title: ids.size ? t('text_f4ea70d7bb', [ids.size]) : t('text_9ab3c99161') }));
}

async function readState() {
  let sessions, captureUnavailable = false;
  try { sessions = await capturedSessions(); }
  catch {
    sessions = lastSessions.map(session => ({ ...session, processed: false, inputRms: null, outputRms: null, enhancement: 'unavailable' }));
    captureUnavailable = true;
  }
  // Titles are only available for tabs for which activeTab was granted.
  const tabs = await external(chrome.tabs.query({}));
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  // Each frame reports separately; do not trust the single sendMessage response
  // to represent every iframe in a tab. Polling only runs while the popup is open.
  const known = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
  const unavailableTabs = [];
  const staleFrames = [];
  await Promise.all(tabs.map(async tab => {
    // A navigation or failed inspection can erase the frame registry while a
    // child still plays. Broadcast first so discovery never depends on that
    // cache. One broadcast response cannot acknowledge every child, so verify
    // the registered and newly reporting frames individually as well.
    let reachable = false;
    try {
      const reply = await external(chrome.tabs.sendMessage(tab.id, { target: 'automatic', type: 'INSPECT' }));
      reachable = reply?.ok === true;
    } catch { /* Pre-install/reload and restricted pages may have no receiver. */ }
    const frames = new Set([0, ...Object.keys(known[tab.id] || {}).map(Number), ...(reports.get(tab.id)?.keys() || [])]);
    await Promise.all([...frames].map(async frameId => {
      const key = `${tab.id}:${frameId}`;
      const documentId = documents.get(key);
      let response;
      try { response = await external(chrome.tabs.sendMessage(tab.id, { target: 'automatic', type: 'INSPECT' }, { frameId })); }
      catch { /* An invalidated or removed content script is not a live report. */ }
      if (response?.ok) reachable = true;
      if (!response?.ok && documents.get(key) === documentId) {
        reports.get(tab.id)?.delete(frameId);
        if (known[tab.id]?.[frameId]) {
          staleFrames.push({ tabId: tab.id, frameId, documentId: known[tab.id][frameId].documentId });
          delete known[tab.id][frameId];
          if (!Object.keys(known[tab.id]).length) delete known[tab.id];
        }
      }
    }));
    if (!reachable && !sessions.some(session => session.tabId === tab.id)) {
      unavailableTabs.push({ tabId: tab.id, audible: tab.audible === true });
    }
  }));
  if (staleFrames.length) await serialized(async () => {
    const latest = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
    for (const { tabId, frameId, documentId } of staleFrames) {
      if (latest[tabId]?.[frameId]?.documentId === documentId && !reports.get(tabId)?.has(frameId)) delete latest[tabId][frameId];
      if (latest[tabId] && !Object.keys(latest[tabId]).length) delete latest[tabId];
    }
    await chrome.storage.session.set({ managedFrames: latest });
  });
  const overrides = await controls();
  const value = await settings();
  const pages = new Map();
  for (const [tabId, frames] of reports) {
    if (!byId.has(tabId)) { reports.delete(tabId); continue; }
    const fresh = [...frames.values()].filter(frame => Date.now() - frame.at < 5000);
    const summary = aggregateFrames(fresh);
    if (summary.mediaCount) pages.set(tabId, {
      ...summary, tabId, mode: 'automatic', title: byId.get(tabId)?.title || fresh.find(frame => frame.title)?.title || t('text_7c8e07cee1'),
    });
  }
  for (const session of sessions) pages.set(session.tabId, { ...session, mode: 'capture', estimated: false });
  const errors = (await chrome.storage.session.get('captureErrors')).captureErrors || {};
  const rows = [...pages.values()].map(page => {
    const control = sanitizeTabControl(overrides[page.tabId]);
    const muted = Boolean(byId.get(page.tabId)?.mutedInfo?.muted);
    const stopped = control.stopped || (page.mode === 'automatic' && !value.autoEnable);
    return { ...page, title: byId.get(page.tabId)?.title || page.title || t('text_7c8e07cee1'),
      captureError: captureUnavailable && page.mode === 'capture' ? t('text_38cf0d730f') : errors[page.tabId] || null,
      muted, stopped, volume: control.volume ?? value.volume, followsGlobal: control.volume === null,
      outputRms: muted ? 0 : page.outputRms };
  });
  await updateBadge(sessions);
  return {
    settings: value,
    ...(captureUnavailable ? { captureUnavailable: true } : {}),
    pages: rows,
    unavailableTabs,
    captureErrors: errors,
    sessions: sessions.map(session => ({
      ...session, title: byId.get(session.tabId)?.title || session.title || t('text_5f4db766b1'),
      muted: Boolean(byId.get(session.tabId)?.mutedInfo?.muted),
    })),
  };
}

function state(fresh = false) {
  if (fresh || !stateRead) {
    const read = readState().finally(() => { if (stateRead === read) stateRead = undefined; });
    stateRead = read;
  }
  return stateRead;
}

async function beginCapture(tab, epoch) {
  if (epoch !== captureEpoch) throw Error(t('text_022246cabd'));
  const old = starts.get(tab.id);
  if (old && !old.controller.signal.aborted) return old.promise;
  if (old) {
    await old.promise.catch(() => {});
    if (epoch !== captureEpoch) throw Error(t('text_022246cabd'));
  }
  const controller = new AbortController(), { signal } = controller;
  const job = { controller };
  starts.set(tab.id, job);
  const checkpoint = () => { if (signal.aborted) throw signal.reason; };
  const deadline = setTimeout(() => controller.abort(Error(t('text_4572a61938'))), 7500);
  job.promise = (async () => {
    try {
      await external(ensureOffscreen(), 1600, signal); checkpoint();
      await serialized(async () => {
        checkpoint();
        const all = await controls(); checkpoint();
        all[tab.id] = { ...sanitizeTabControl(all[tab.id]), stopped: false };
        await chrome.storage.session.set({ tabControls: all });
      }); checkpoint();
      const existing = await audio('STATE', {}, signal); checkpoint();
      if (!existing.some(session => session.tabId === tab.id)) {
        await sendPage(tab.id, true); checkpoint();
        const streamId = await external(chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }), 1500, signal); checkpoint();
        const value = await pageSettings(tab.id); checkpoint();
        await audio('START', { tabId: tab.id, title: tab.title, streamId, settings: value }, signal); checkpoint();
        await audio('TAB_SETTINGS', { tabId: tab.id, settings: await pageSettings(tab.id) }, signal); checkpoint();
        await captureError(tab.id, null); checkpoint();
      }
      await sendPage(tab.id, true); checkpoint();
    } catch (error) {
      controller.abort(error);
      // STOP reaches the owner even after our START reply deadline expires.
      // A browser-created stream that completes later is disposed by that owner.
      if (starts.get(tab.id) === job) {
        await stopCapture('STOP', tab.id);
        await sendPage(tab.id, false);
        if (!job.cancelled) await captureError(tab.id, t('text_ed1290cf4a', [error.message]));
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      if (starts.get(tab.id) === job) starts.delete(tab.id);
    }
  })();
  return job.promise;
}

async function handle(message, sender) {
  if (message.type === 'GET_SETTINGS') return settings();
  if (message.type === 'PAGE_PRESENCE') {
    if (!Number.isInteger(message.mediaCount) || message.mediaCount < 0 || message.mediaCount > 10000) return;
    await serialized(async () => {
      if (!isCurrentDocument(sender)) return;
      const stored = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
      const tabId = sender.tab.id, frameId = sender.frameId || 0;
      const documentId = sender.documentId || sender.url;
      stored[tabId] ||= {};
      const previous = stored[tabId][frameId];
      if (message.mediaCount) stored[tabId][frameId] = { count: message.mediaCount, documentId };
      else if (!previous || previous.documentId === documentId) delete stored[tabId][frameId];
      if (!Object.keys(stored[tabId]).length) delete stored[tabId];
      await chrome.storage.session.set({ managedFrames: stored });
    });
    await updateBadge(await capturedSessions());
    return;
  }
  if (message.type === 'PAGE_STATE') {
    const sessions = await capturedSessions();
    return { settings: await pageSettings(sender.tab.id), captured: sessions.some(session => session.tabId === sender.tab.id) };
  }
  if (message.type === 'SESSIONS_CHANGED') {
    if (sender.url !== OFFSCREEN_URL) throw new Error(t('text_2bb4d85145'));
    if (Number.isInteger(message.failedTabId)) await captureError(message.failedTabId, message.error || t('text_0b95c2fde6'));
    const sessions = await capturedSessions();
    await updateBadge(sessions);
    if (!sessions.length) await closeIfIdle();
    await syncPages(sessions);
    return;
  }
  if (message.type === 'STATE') return state();
  if (message.type === 'TAB_CONTROL') {
    if (!Number.isInteger(message.tabId)) throw new Error(t('text_fb2a191a48'));
    if (message.stopped === true) await stopCapture('STOP', message.tabId);
    const tab = await external(chrome.tabs.get(message.tabId));
    if (typeof message.muted === 'boolean') await external(chrome.tabs.update(tab.id, { muted: message.muted }));
    await serialized(async () => {
      const all = await controls();
      const current = sanitizeTabControl(all[tab.id]);
      if (message.volume === null) current.volume = null;
      else if (Number.isFinite(message.volume)) current.volume = message.volume;
      else if (message.delta === 10 || message.delta === -10) current.volume = (current.volume ?? (await settings()).volume) + message.delta;
      if (typeof message.stopped === 'boolean') current.stopped = message.stopped;
      all[tab.id] = sanitizeTabControl(current);
      await chrome.storage.session.set({ tabControls: all });
    });
    await syncPages(await capturedSessions());
    return state(true);
  }
  if (message.type === 'SETTINGS') {
    const next = await serialized(async () => {
      const value = sanitizeSettings({ ...await settings(), ...message.settings });
      await chrome.storage.local.set({ settings: value });
      return value;
    });
    // Persistence is ordered, but no page/offscreen IPC holds that queue.
    try {
      const sessions = await capturedSessions();
      await syncPages(sessions);
      await updateBadge(sessions);
    } catch { /* Saved settings remain readable while live application is unavailable. */ }
    return next;
  }
  if (message.type === 'AUTO_START' || message.type === 'START') {
    const epoch = captureEpoch;
    const [tab] = await external(chrome.tabs.query({ active: true, currentWindow: true }));
    if (message.type === 'AUTO_START') {
      const snapshot = await state();
      const page = snapshot.pages.find(page => page.tabId === tab?.id);
      if (snapshot.captureUnavailable || !snapshot.settings.autoEnable || !page || page.stopped || page.mode === 'capture' ||
          !(page.requiresCapture || (page.playingCount > 0 && !page.processed))) return snapshot;
    }
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) throw Error(t('unsupportedPage'));
    if (message.tabId !== undefined && message.tabId !== tab.id) throw Error(t('text_3a1f972b64'));
    await beginCapture(tab, epoch);
    return state(true);
  }
  if (message.type === 'STOP' || message.type === 'STOP_ALL') {
    await stopCapture(message.type, message.tabId);
    await syncPages(await capturedSessions());
    return state(true);
  }
  throw new Error(t('text_f77a351106'));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  const popupUrl = chrome.runtime.getURL('popup.html');
  const trustedPage = sender.url === popupUrl || sender.url === OFFSCREEN_URL;
  if (sender.url === OFFSCREEN_URL && message.type !== 'SESSIONS_CHANGED') return;
  if (!trustedPage && sender.tab && message.type === 'PAGE_REPORT') {
    if (!isCurrentDocument(sender)) { respond({ ok: true }); return; }
    const raw = message.data;
    if (raw && Number.isInteger(raw.mediaCount) && raw.mediaCount >= 0 && raw.mediaCount <= 10000 &&
        Number.isInteger(raw.playingCount) && raw.playingCount >= 0 && raw.playingCount <= raw.mediaCount) {
      const safeLevel = level => Number.isFinite(level) && level >= 0 && level <= 100 ? level : null;
      if (!reports.has(sender.tab.id)) reports.set(sender.tab.id, new Map());
      reports.get(sender.tab.id).set(sender.frameId || 0, {
        mediaCount: raw.mediaCount, playingCount: raw.playingCount,
        inputRms: safeLevel(raw.inputRms), outputRms: safeLevel(raw.outputRms),
        enhancement: ['off', 'idle'].includes(raw.enhancement) ? raw.enhancement : 'unavailable',
        requiresCapture: raw.requiresCapture === true,
        processed: raw.processed === true, outputPeak: safeLevel(raw.outputPeak),
        minGain: safeLevel(raw.minGain), maxGain: safeLevel(raw.maxGain),
        minPreLimiterGain: safeLevel(raw.minPreLimiterGain), maxPreLimiterGain: safeLevel(raw.maxPreLimiterGain),
        title: sender.frameId ? '' : String(raw.title || '').slice(0, 200), at: Date.now(),
      });
    }
    respond({ ok: true });
    return;
  }
  if (!trustedPage && (!sender.tab || !['PAGE_STATE', 'PAGE_PRESENCE'].includes(message.type))) return;
  if (sender.tab && message.type === 'PAGE_STATE') {
    // Register before waiting behind STATE/SETTINGS. Live reports from a new
    // document must not be rejected while its settings request is queued.
    const key = documentKey(sender);
    const documentId = sender.documentId || sender.url;
    if (documents.get(key) !== documentId) reports.get(sender.tab.id)?.delete(sender.frameId || 0);
    documents.set(key, documentId);
  }
  if (message.type === 'STOP_ALL') cancelStarts();
  if (message.type === 'STOP' || (message.type === 'TAB_CONTROL' && message.stopped === true)) cancelStarts(message.tabId);
  if (['SETTINGS', 'TAB_CONTROL', 'STOP', 'STOP_ALL'].includes(message.type)) configEpoch++;
  handle(message, sender).then(
    data => respond({ ok: true, data }),
    error => respond({ ok: false, error: error.message }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  cancelStarts(tabId);
  reports.delete(tabId);
  for (const key of documents.keys()) if (key.startsWith(`${tabId}:`)) documents.delete(key);
  stopCapture('STOP', tabId).catch(console.error);
  serialized(async () => {
    const all = await controls();
    delete all[tabId];
    await chrome.storage.session.set({ tabControls: all });
    const stored = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
    delete stored[tabId];
    await chrome.storage.session.set({ managedFrames: stored });
  }).then(async () => {
    await captureError(tabId, null);
    await updateBadge(await capturedSessions());
  }).catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') {
    cancelStarts(tabId);
    reports.delete(tabId);
    serialized(async () => {
      const stored = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
      delete stored[tabId];
      await chrome.storage.session.set({ managedFrames: stored });
    }).then(async () => updateBadge(await capturedSessions())).catch(console.error);
  }
  if (change.mutedInfo) {
    configEpoch++;
    (async () => {
    await syncPages(await capturedSessions());
    })().catch(console.error);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  serialized(async () => {
    await chrome.storage.local.set({ settings: await settings() });
  }).then(() => updateBadge([])).catch(console.error);
});
