import { t, localizeDocument, setFallbackMessages } from './i18n.js';
import { sanitizeSettings } from './settings.js';

const sessions = new Map(), starting = new Map();
let context;
let currentSettings = sanitizeSettings();
let alive = true;
const STARTUP_MS = 5000;

function releaseStream(stream) {
  for (const track of stream.getTracks()) {
    track.onended = track.onmute = null;
    track.stop();
  }
}

// Abort ends our wait, not the browser operation. getUserMedia results have an
// explicit late-result disposer below; context initialization owns its cleanup.
function waitFor(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function closeIdleContext() {
  if (sessions.size || [...starting.values()].some(job => !job.controller.signal.aborted)) return;
  const old = context;
  context = undefined;
  if (old) old.engine.close().catch(() => {});
}

async function getContext(signal) {
  if (!context || context.engine.state === 'closed') {
    const engine = new AudioContext({ latencyHint: 'interactive' });
    const record = { engine };
    context = record;
    record.ready = (async () => {
      try {
        await engine.audioWorklet.addModule(chrome.runtime.getURL('normalizer-worklet.js'));
        if (context !== record || !alive) throw Error(t('text_3d291aa5b5'));
        if (engine.state === 'suspended') await engine.resume();
        if (context !== record || engine.state !== 'running') throw Error(t('text_78f19f242c'));
        return engine;
      } catch (error) {
        if (context === record) context = undefined;
        engine.close().catch(() => {});
        throw error;
      }
    })();
  }
  return waitFor(context.ready, signal);
}

function stop(tabId) {
  starting.get(tabId)?.controller.abort(Error(t('text_022246cabd')));
  const session = sessions.get(tabId);
  if (session) {
    sessions.delete(tabId);
    clearInterval(session.watchdog);
    session.node.onprocessorerror = null;
    session.node.port.onmessage = null;
    try { session.node.port.postMessage({ type: 'dispose' }); } catch { /* Already closed. */ }
    session.node.port.close();
    session.source.disconnect();
    session.node.disconnect();
    releaseStream(session.stream);
  }
  closeIdleContext();
}

function notify(failedTabId, error) {
  // Resource release never waits for a service worker acknowledgement.
  chrome.runtime.sendMessage({ target: 'background', type: 'SESSIONS_CHANGED', failedTabId, error }).catch(console.error);
}

function start(message) {
  if (!alive) return Promise.reject(Error(t('text_b028661ebd')));
  if (sessions.has(message.tabId)) return Promise.resolve();
  const previous = starting.get(message.tabId);
  if (previous && !previous.controller.signal.aborted) return previous.promise;
  const controller = new AbortController(), { signal } = controller;
  const job = { controller, settings: sanitizeSettings(message.settings) };
  starting.set(message.tabId, job);
  // The owner deadline exists before module loading, resume or capture starts.
  const deadline = setTimeout(() => controller.abort(Error(t('text_44c76c2546'))), STARTUP_MS);
  job.promise = (async () => {
    let stream, source, node;
    try {
      const engine = await getContext(signal);
      const acquisition = navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
        video: false,
      }).then(result => {
        if (signal.aborted || !alive) releaseStream(result);
        return result;
      });
      stream = await waitFor(acquisition, signal);
      if (signal.aborted || !alive) throw signal.reason || Error(t('text_10bfbf41cb'));
      currentSettings = job.settings;
      source = engine.createMediaStreamSource(stream);
      node = new AudioWorkletNode(engine, 'balance-normalizer', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', processorOptions: currentSettings,
      });
      const session = { tabId: message.tabId, title: message.title, stream, source, node, settings: currentSettings,
        processed: false, enhancement: 'switching', inputRms: 0, outputRms: 0, outputPeak: 0, gain: 1, limiterReductionDb: 0 };
      // Zero PCM alone cannot identify failed capture: silence, pause and user
      // mute are valid. Verify render liveness independently of signal energy.
      // Missing metrics or nonzero input with missing output releases capture.
      let lastMetrics = performance.now(), lastGoodOutput = lastMetrics;
      const fail = reason => {
        if (sessions.get(message.tabId) !== session) return;
        stop(message.tabId);
        notify(message.tabId, t('text_7c63175b61', [reason]));
      };
      node.port.onmessage = ({ data }) => {
        if (sessions.get(message.tabId) !== session) return;
        Object.assign(session, data);
        lastMetrics = performance.now();
        const input = Number.isFinite(data.inputRms) && data.inputRms > 1e-7;
        const output = Number.isFinite(data.outputRms) && data.outputRms > 1e-7;
        if (input && (session.settings.volume === 0 || output)) session.processed = true;
        if (!input || session.settings.volume === 0 || output) lastGoodOutput = lastMetrics;
      };
      session.watchdog = setInterval(() => {
        if (sessions.get(message.tabId) !== session) return;
        const now = performance.now();
        if (engine.state !== 'running' || now - lastMetrics > 1500 || now - lastGoodOutput > 1500 ||
            !stream.getAudioTracks().some(track => track.readyState === 'live' && !track.muted)) {
          fail(t('text_b468dc2e6e'));
        }
      }, 500);
      node.onprocessorerror = () => fail(t('text_ec9a458952'));
      sessions.set(message.tabId, session);
      source.connect(node).connect(engine.destination);
      for (const track of stream.getTracks()) track.onended = track.onmute = () => fail(t('text_a60dd21571'));
      if (!stream.active) throw Error(t('text_62d4d18bee'));
    } catch (error) {
      // Never let a cancelled attempt stop a replacement of the same tab.
      if (stream && sessions.get(message.tabId)?.stream === stream) {
        const session = sessions.get(message.tabId);
        sessions.delete(message.tabId);
        clearInterval(session.watchdog);
      }
      if (node) {
        node.onprocessorerror = null; node.port.onmessage = null;
        try { node.port.postMessage({ type: 'dispose' }); } catch { /* Already closed. */ }
        node.port.close(); node.disconnect();
      }
      source?.disconnect();
      if (stream) releaseStream(stream);
      throw error;
    } finally {
      clearTimeout(deadline);
      if (starting.get(message.tabId) === job) starting.delete(message.tabId);
      closeIdleContext();
    }
  })();
  return job.promise;
}

function snapshot() {
  return [...sessions.values()].map(({ tabId, title, inputRms, outputRms, outputPeak, gain, limiterReductionDb, enhancement, processed }) =>
    ({ tabId, title, inputRms, outputRms, outputPeak, gain, limiterReductionDb, enhancement, processed }));
}

async function handle(message) {
  switch (message.type) {
    case 'START': await start(message); break;
    case 'STOP': stop(message.tabId); break;
    case 'STOP_ALL': [...new Set([...sessions.keys(), ...starting.keys()])].forEach(stop); break;
    case 'TAB_SETTINGS': {
      const job = starting.get(message.tabId);
      if (job && !job.controller.signal.aborted) job.settings = sanitizeSettings(message.settings);
      const session = sessions.get(message.tabId);
      if (session) {
        session.settings = sanitizeSettings(message.settings);
        session.node.port.postMessage(session.settings);
      }
      break;
    }
    case 'SETTINGS':
      currentSettings = sanitizeSettings(message.settings);
      for (const job of starting.values()) if (!job.controller.signal.aborted) job.settings = currentSettings;
      for (const session of sessions.values()) {
        session.settings = currentSettings;
        session.node.port.postMessage(currentSettings);
      }
      break;
    case 'STATE': return snapshot();
    case 'IDLE': return !sessions.size && ![...starting.values()].some(job => !job.controller.signal.aborted);
    default: throw new Error(t('text_cb5fbb4c65'));
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id ||
      sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) return;
  setFallbackMessages(message.i18n);
  if (typeof document !== 'undefined') localizeDocument();
  // Reads and stop are never queued behind a pending browser capture request.
  handle(message).then(data => respond({ ok: true, data }),
    error => respond({ ok: false, error: error.message }));
  return true;
});

window.addEventListener('pagehide', () => {
  alive = false;
  [...new Set([...sessions.keys(), ...starting.keys()])].forEach(stop);
  closeIdleContext();
});
