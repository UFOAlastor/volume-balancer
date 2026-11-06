(() => {
  const elements = new Map();
  const roots = new Set();
  let settings = { volume: 100, normalize: true, autoEnable: true, maxDbfs: -1, enhancement: 'off' };
  const LEASE = 'data-volume-balancer-lease', ACK = 'data-volume-balancer-ack';
  const INTENT = 'data-volume-balancer-intent';
  const CONTROL = 'data-volume-balancer-control';
  const controlling = media => performance.now() < Number(media.getAttribute(CONTROL) || 0);
  let captured = false;
  let ready = false;
  let engine;
  let activationResume;
  let moduleReady;
  let timer;
  let alive = true;
  let documentActive = true;
  let presenceTimer;
  let lastPresence = -1;
  let recoveryTimer;
  let statePending = false;
  let settingsEpoch = 0;
  let observer;
  let messageEvent;
  const rootEvents = { play: onPlay, playing: onPlay, pause: onStop, ended: onStop,
    loadedmetadata: onMetadata, canplay: onPlay, emptied: onMetadata };

  function quietly(task) {
    try { task()?.catch?.(() => {}); } catch { /* Cleanup must continue after a resource was already closed. */ }
  }

  function dispose() {
    if (!alive) return;
    alive = false;
    ready = false;
    documentActive = false;
    clearInterval(timer); clearInterval(recoveryTimer); clearTimeout(presenceTimer);
    timer = recoveryTimer = presenceTimer = undefined;
    quietly(() => observer?.disconnect());
    for (const root of roots) for (const [name, listener] of Object.entries(rootEvents)) {
      quietly(() => root.removeEventListener(name, listener, true));
    }
    roots.clear();
    for (const [media, entry] of elements) {
      quietly(() => rememberVolume(media, entry));
      quietly(() => media.removeEventListener('volumechange', entry.onVolume));
      quietly(() => media.removeEventListener('volumechange', entry.onMute));
      quietly(() => media.removeEventListener('volume-balancer-intent', entry.onIntent));
      quietly(() => media.removeEventListener('volume-balancer-control', entry.onControl));
      quietly(() => media.removeEventListener('volume-balancer-expired', entry.onExpire));
      quietly(() => release(entry));
      quietly(() => write(media, entry, entry.original));
    }
    elements.clear();
    quietly(() => messageEvent?.removeListener(onMessage));
    quietly(() => window.removeEventListener('pageshow', onPageShow));
    quietly(() => window.removeEventListener('pagehide', onPageHide));
    const context = engine;
    engine = moduleReady = activationResume = undefined;
    quietly(() => context?.close());
  }

  function runtimeAccess() {
    if (!alive) return;
    try {
      const runtime = globalThis.chrome?.runtime;
      const id = runtime?.id, sendMessage = runtime?.sendMessage, getURL = runtime?.getURL;
      if (!id || typeof sendMessage !== 'function' || typeof getURL !== 'function') throw Error('Extension context unavailable');
      return { runtime, id, sendMessage, getURL };
    } catch {
      dispose();
    }
  }

  async function send(message) {
    const api = runtimeAccess();
    if (!api) return;
    try {
      const response = await api.sendMessage.call(api.runtime, message);
      return runtimeAccess() ? response : undefined;
    } catch (error) {
      let invalidated;
      try { invalidated = /extension context invalidated/i.test(String(error?.message || error)); }
      catch { dispose(); return; }
      if (invalidated) dispose();
      else runtimeAccess(); // A transient worker/channel failure can still be retried.
    }
  }

  function readSettings(force = false) {
    if (!alive || statePending || !documentActive) return;
    statePending = true;
    const epoch = settingsEpoch;
    send({ target: 'background', type: 'PAGE_STATE' }).then(response => {
      if (alive && (!ready || force) && epoch === settingsEpoch && response?.ok) update(response.data);
    }).finally(() => { statePending = false; });
  }

  function recover() {
    if (!documentActive || !runtimeAccess()) return;
    if (!ready) readSettings();
    // Also find players inside a shadow root attached after its host was added.
    pruneRoots();
    for (const root of roots) discover(root);
    tick();
    resumeAfterActivation();
    for (const [media, entry] of elements) {
      if (!active() || !media.isConnected || media.paused || media.ended || entry.meter || entry.pending) continue;
      if (performance.now() < (entry.retryAt || 0)) continue;
      entry.failed = false;
      engine?.resume().catch(() => {});
      analyse(media, entry);
    }
    if (presence()) report();
  }

  function resumeAfterActivation() {
    const context = engine;
    if (!active() || context?.state !== 'suspended' || activationResume === context ||
        !globalThis.navigator?.userActivation?.hasBeenActive ||
        ![...elements.keys()].some(media => media.isConnected && !media.paused && !media.ended)) return;
    // Muted autoplay can leave the first resume() pending. Unmuting does not
    // emit play, and entry.pending excludes another analyse/recovery attempt.
    // Retry once after real page activation; never pile up blocked promises.
    activationResume = context;
    try {
      context.resume().catch(() => { if (activationResume === context) activationResume = undefined; });
    } catch { if (activationResume === context) activationResume = undefined; }
  }

  function startRecovery() {
    if (!alive) return;
    recoveryTimer ||= setInterval(recover, 1000);
  }

  function presence(force = false) {
    if (!runtimeAccess()) return false;
    const mediaCount = documentActive ? [...elements.keys()].filter(media => media.isConnected).length : 0;
    if (!force && mediaCount === lastPresence) return false;
    lastPresence = mediaCount;
    send({ target: 'background', type: 'PAGE_PRESENCE',
      mediaCount,
    }).then(response => { if (alive && !response?.ok) lastPresence = -1; });
    return true;
  }

  function schedulePresence() {
    if (!alive || presenceTimer) return;
    presenceTimer = setTimeout(() => { presenceTimer = undefined; if (presence()) report(); }, 50);
  }

  function requestedVolume(entry) {
    // Native sampled mode scales the player's intent, not an absolute slider
    // position. At 100% with normalization off, quiet audio keeps that intent.
    const requested = entry.original * settings.volume / 100 * (settings.normalize ? entry.gain : 1);
    // This path only has observed samples, with a decaying peak hold. Assuming
    // full-scale PCM here pinned every quiet player to 89% (-1 dB) / 79% (-2 dB).
    // It is sampled attenuation, not the worklet's lookahead peak guarantee.
    const peak = entry.peak || 0;
    return Math.min(requested, peak > 0 ? 10 ** (settings.maxDbfs / 20) / peak : requested);
  }

  const active = () => alive && ready && documentActive && settings.autoEnable && !captured;
  const nativeVolume = entry => active() && settings.volume === 0 ? 0 : entry.original;

  function rememberVolume(media, entry) {
    // DOM volumechange is asynchronous. A source/pause/settings event can run
    // first; preserve a new player/user value before any restoration write.
    if (Math.abs(media.volume - entry.applied) > 0.0001) {
      entry.original = media.volume;
      entry.applied = media.volume;
    }
  }

  function write(media, entry, volume) {
    if (volume === 0 && entry.original > 0) {
      const lease = JSON.stringify({ volume: entry.original, until: performance.now() + 1200 });
      media.setAttribute(LEASE, lease);
      media.dispatchEvent(new Event('volume-balancer-lease', { bubbles: true, composed: true }));
      if (media.getAttribute(ACK) !== lease) return false; // Never suppress without independent recovery.
    } else {
      media.removeAttribute(LEASE); media.removeAttribute(ACK);
    }
    entry.applied = Math.max(0, Math.min(1, volume));
    if (Math.abs(media.volume - entry.applied) > 0.0001) media.volume = entry.applied;
    return true;
  }

  function release(entry) {
    entry.generation = (entry.generation || 0) + 1;
    entry.pending = false;
    const meter = entry.meter;
    entry.meter = undefined;
    if (!meter) return;
    quietly(() => meter.gate?.disconnect());
    if (meter.node) {
      quietly(() => { meter.node.onprocessorerror = null; });
      quietly(() => { meter.node.port.onmessage = null; });
      quietly(() => meter.node.port.postMessage({ type: 'dispose' }));
      quietly(() => meter.node.port.close());
      quietly(() => meter.node.disconnect());
    }
    quietly(() => meter.source.disconnect());
    quietly(() => meter.analyser?.disconnect());
    let tracks = [];
    quietly(() => { tracks = meter.stream.getTracks(); });
    for (const track of tracks) {
      quietly(() => { track.onended = null; track.onmute = null; });
      quietly(() => track.stop());
    }
  }

  function closeEngine() {
    const context = engine;
    engine = moduleReady = activationResume = undefined;
    if (context) {
      context.onstatechange = null;
      quietly(() => context.close());
    }
  }

  function quiesce() {
    const entries = [...elements.values()];
    if (!entries.some(entry => entry.meter && !entry.meter.node)) {
      clearInterval(timer); timer = undefined;
    }
    if (!elements.size) closeEngine();
    else if (engine?.state === 'running' && !entries.some(entry => entry.meter || entry.pending)) {
      quietly(() => engine.suspend());
    }
  }

  async function analyse(media, entry) {
    if (!active() || controlling(media) || media.paused || entry.meter || entry.failed || entry.pending) return;
    if (!media.captureStream || media.readyState < 3) return;
    entry.pending = true;
    const generation = entry.generation || 0;
    let stream, source, analyser, node, gate;
    try {
      // Observe a copy, never irreversibly take over the media element with
      // createMediaElementSource (a later cross-origin source could go silent).
      if (!engine) {
        engine = new AudioContext();
        const context = engine;
        context.onstatechange = () => { if (engine === context && context.state !== 'running') tick(); };
      }
      const context = engine;
      await context.resume();
      // Do not suppress native playback while autoplay keeps Web Audio suspended.
      if (context.state !== 'running' || !active() || generation !== (entry.generation || 0)) return;
      let workletAvailable = false;
      if (context.audioWorklet) {
        const api = runtimeAccess();
        if (!api) return;
        let url;
        try { url = api.getURL.call(api.runtime, 'normalizer-worklet.js'); }
        catch { dispose(); return; }
        moduleReady ||= context.audioWorklet.addModule(url);
        try { await moduleReady; workletAvailable = true; } catch { /* Keep upstream sampled mode. */ }
      }
      if (!alive || !active() || !media.isConnected || media.paused || generation !== (entry.generation || 0)) return;
      stream = media.captureStream();
      stream.getVideoTracks().forEach(track => track.stop());
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach(track => track.stop()); return; }
      if (!stream.getAudioTracks().some(track => track.readyState === 'live' && !track.muted)) {
        stream.getTracks().forEach(track => track.stop()); return;
      }
      source = context.createMediaStreamSource(stream);
      if (!workletAvailable) {
        analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        entry.meter = { stream, source, analyser, samples: new Float32Array(analyser.fftSize), verified: false, lastSignal: performance.now() };
        timer ||= setInterval(tick, 25);
        return;
      }
      node = new AudioWorkletNode(context, 'balance-normalizer', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', processorOptions: { ...settings, levelerState: entry.levelerState, requiresHeartbeat: true },
      });
      gate = context.createGain();
      gate.gain.value = 0;
      const meter = { stream, source, node, gate, metrics: null, verified: false,
        lastSignal: performance.now(), lastMetrics: performance.now() };
      const fallback = () => {
        if (entry.meter !== meter) return;
        rememberVolume(media, entry);
        release(entry);
        entry.failed = true;
        entry.retryAt = performance.now() + Math.min(8000, 1000 * 2 ** Math.min(3, entry.failures || 0));
        entry.failures = (entry.failures || 0) + 1;
        if (alive && media.isConnected) write(media, entry, nativeVolume(entry));
      };
      node.onprocessorerror = fallback;
      for (const track of stream.getAudioTracks()) { track.onended = fallback; track.onmute = fallback; }
      node.port.onmessage = ({ data }) => {
        // A track can stay live while CORS/decoder restrictions deliver zeros.
        // Also reject callbacks queued before stop/source change/disposal.
        if (entry.meter !== meter || !active() || media.paused || !media.isConnected) return;
        node.port.postMessage({ type: 'heartbeat' });
        rememberVolume(media, entry);
        meter.metrics = data;
        meter.lastMetrics = performance.now();
        if (media.muted || entry.original === 0 || settings.volume === 0) {
          meter.lastSignal = performance.now(); // Intentional silence is healthy rendering.
          apply(media, entry); return;
        }
        entry.levelerState = data.levelerState;
        if (Number.isFinite(data.inputRms) && data.inputRms > 1e-7 &&
            Number.isFinite(data.outputRms) && data.outputRms > 1e-7) {
          meter.lastSignal = performance.now();
          if (!media.muted && entry.original > 0 && settings.volume > 0) {
            meter.verified = true;
            if (!write(media, entry, 0)) { fallback(); return; }
            gate.gain.value = entry.original;
          }
          entry.failures = 0;
        }
      };
      node.port.postMessage({ ...settings, volume: media.muted || entry.original === 0 ? 0 : settings.volume });
      source.connect(node).connect(gate).connect(context.destination);
      entry.meter = meter;
      meter.fallback = fallback;
    } catch {
      source?.disconnect(); analyser?.disconnect(); gate?.disconnect();
      if (node) { node.disconnect(); node.port.close(); }
      stream?.getTracks().forEach(track => track.stop());
      entry.failed = true;
      entry.retryAt = performance.now() + Math.min(8000, 1000 * 2 ** Math.min(3, entry.failures || 0));
      entry.failures = (entry.failures || 0) + 1;
    } finally {
      if (generation === (entry.generation || 0)) entry.pending = false;
    }
  }

  function apply(media, entry) {
    rememberVolume(media, entry);
    if (controlling(media)) { release(entry); write(media, entry, entry.original); return; }
    if (active()) {
      if (entry.meter?.node) {
        const meter = entry.meter;
        meter.node.port.postMessage({ ...settings, volume: media.muted || entry.original === 0 ? 0 : settings.volume });
        if (media.muted || entry.original === 0 || settings.volume === 0) {
          meter.gate.gain.value = 0;
          meter.verified = false;
          write(media, entry, settings.volume === 0 ? 0 : entry.original);
        } else {
          meter.gate.gain.value = meter.verified ? entry.original : 0;
          write(media, entry, meter.verified ? 0 : nativeVolume(entry));
        }
      } else {
        // Unproven or unavailable capture must leave native playback alone.
        write(media, entry, entry.meter?.verified && !media.muted ? (entry.original === 0 ? 0 : requestedVolume(entry)) : nativeVolume(entry));
        analyse(media, entry);
      }
    } else {
      release(entry);
      entry.gain = 1;
      entry.levelerState = undefined;
      entry.leveler = new globalThis.BalanceLeveler();
      write(media, entry, nativeVolume(entry));
    }
  }

  function tick() {
    if (!runtimeAccess()) return;
    for (const [media, entry] of elements) {
      rememberVolume(media, entry);
      if (!media.isConnected) { release(entry); media.removeEventListener('volumechange', entry.onVolume); media.removeEventListener('volumechange', entry.onMute); media.removeEventListener('volume-balancer-intent', entry.onIntent); media.removeEventListener('volume-balancer-control', entry.onControl); media.removeEventListener('volume-balancer-expired', entry.onExpire); elements.delete(media); continue; }
      if (!active() || controlling(media) || media.paused || media.ended) {
        release(entry);
        write(media, entry, nativeVolume(entry));
        continue;
      }
      if (!entry.meter) continue;
      if (engine.state !== 'running') { release(entry); write(media, entry, nativeVolume(entry)); continue; }
      if (entry.meter.node) {
        const meter = entry.meter, now = performance.now();
        // Silence is ambiguous (including restricted PCM). Relinquish ownership
        // instead of holding native output at zero indefinitely.
        if (now - meter.lastMetrics > 1500 || now - meter.lastSignal > 1500) meter.fallback();
        continue;
      }
      const { analyser, samples } = entry.meter;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      let peak = 0;
      for (const sample of samples) { energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      const now = performance.now();
      // Background timer delays are not evidence of seconds of quiet audio.
      const seconds = Math.min(0.1, Math.max(0.001, (now - (entry.lastTick ?? now - 25)) / 1000));
      entry.lastTick = now;
      entry.peak = Math.max(peak, (entry.peak || 0) * Math.exp(-seconds / 2));
      const rms = Math.sqrt(energy / samples.length);
      const liveTrack = entry.meter.stream.getAudioTracks().some(track => track.readyState === 'live' && !track.muted);
      if (liveTrack && rms > 1e-7) { entry.meter.verified = true; entry.meter.lastSignal = now; }
      if (!liveTrack || now - entry.meter.lastSignal > 1500) {
        release(entry);
        entry.retryAt = now + 2000;
        write(media, entry, nativeVolume(entry));
        continue;
      }
      if (!entry.meter.verified) continue;
      if (media.muted) { write(media, entry, nativeVolume(entry)); continue; }
      // Captured media volume is independent of the element's volume setting.
      entry.gain = entry.leveler.update(rms * rms, seconds, settings.normalize);
      // Limit sampled peaks even if loudness normalization is disabled.
      write(media, entry, entry.original === 0 ? 0 : requestedVolume(entry));
    }
    quiesce();
  }

  function track(media) {
    if (!alive || !(media instanceof HTMLMediaElement) || elements.has(media)) return;
    const entry = { original: media.volume, applied: media.volume, gain: 1,
      leveler: new globalThis.BalanceLeveler() };
    entry.onVolume = () => {
      if (Math.abs(media.volume - entry.applied) < 0.0001) return;
      entry.original = media.volume;
      if (active()) apply(media, entry);
      else entry.applied = media.volume;
    };
    media.addEventListener('volumechange', entry.onVolume);
    entry.onMute = () => {
      if (entry.meter?.node) apply(media, entry);
      resumeAfterActivation();
    };
    media.addEventListener('volumechange', entry.onMute);
    entry.onIntent = () => {
      if (media.getAttribute(INTENT) !== '0') return;
      media.removeAttribute(INTENT);
      entry.original = entry.applied = 0;
      apply(media, entry);
    };
    media.addEventListener('volume-balancer-intent', entry.onIntent);
    entry.onControl = () => { apply(media, entry); quiesce(); };
    media.addEventListener('volume-balancer-control', entry.onControl);
    entry.onExpire = () => {
      rememberVolume(media, entry); release(entry);
      entry.failed = true; entry.retryAt = performance.now() + 1000;
      write(media, entry, entry.original); quiesce();
    };
    media.addEventListener('volume-balancer-expired', entry.onExpire);
    elements.set(media, entry);
    apply(media, entry);
    schedulePresence();
  }

  function discover(node) {
    if (!alive) return;
    if (node instanceof HTMLMediaElement) track(node);
    if (node.shadowRoot) observe(node.shadowRoot);
    if (!node.querySelectorAll) return;
    node.querySelectorAll('audio,video').forEach(track);
    node.querySelectorAll('*').forEach(element => { if (element.shadowRoot) observe(element.shadowRoot); });
  }

  observer = new MutationObserver(records => {
    if (!runtimeAccess()) return;
    for (const record of records) record.addedNodes.forEach(discover);
    // Release removed players even when no analyser interval is running.
    for (const [media, entry] of elements) {
      rememberVolume(media, entry);
      if (!media.isConnected) {
        release(entry);
        write(media, entry, nativeVolume(entry));
        media.removeEventListener('volumechange', entry.onVolume); media.removeEventListener('volumechange', entry.onMute);
        media.removeEventListener('volume-balancer-intent', entry.onIntent); media.removeEventListener('volume-balancer-control', entry.onControl); media.removeEventListener('volume-balancer-expired', entry.onExpire);
        elements.delete(media);
      }
    }
    pruneRoots();
    quiesce();
    schedulePresence();
  });

  function pruneRoots() {
    let removed = false;
    for (const root of roots) {
      if (!root.host || root.host.isConnected) continue;
      for (const [name, listener] of Object.entries(rootEvents)) root.removeEventListener(name, listener, true);
      roots.delete(root); removed = true;
    }
    if (removed) {
      observer.disconnect();
      for (const root of roots) observer.observe(root, { childList: true, subtree: true });
    }
  }

  function observe(root) {
    if (!alive || roots.has(root)) return;
    roots.add(root);
    observer.observe(root, { childList: true, subtree: true });
    for (const [name, listener] of Object.entries(rootEvents)) root.addEventListener(name, listener, true);
    discover(root);
  }

  function onPlay(event) {
    if (!runtimeAccess()) return;
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    track(media);
    const entry = elements.get(media);
    entry.failed = false;
    entry.retryAt = 0;
    apply(media, entry);
    engine?.resume().then(() => { if (alive && active() && elements.get(media) === entry) analyse(media, entry); }).catch(() => {});
  }

  function onMetadata(event) {
    if (!runtimeAccess()) return;
    const entry = elements.get(event.target);
    if (entry) {
      release(entry);
      entry.failed = false;
      entry.retryAt = 0;
      entry.peak = undefined;
      entry.lastTick = undefined;
      // Keep attenuation across playlist changes; do not restart the next clip loud.
      apply(event.target, entry);
    }
  }

  function onStop(event) {
    if (!runtimeAccess()) return;
    const media = event.target, entry = elements.get(media);
    if (!entry || !media.paused && !media.ended) return;
    rememberVolume(media, entry);
    release(entry);
    write(media, entry, nativeVolume(entry));
    quiesce();
  }

  function update(data) {
    if (!alive) return;
    settingsEpoch++;
    settings = { ...settings, ...data.settings, enhancement: 'off' };
    captured = Boolean(data.captured);
    ready = true;
    for (const [media, entry] of elements) apply(media, entry);
    if (!active() && engine) {
      closeEngine();
    }
    schedulePresence();
    if (settings.autoEnable && !captured) startRecovery();
    else { clearInterval(recoveryTimer); recoveryTimer = undefined; }
  }

  async function report() {
    if (!runtimeAccess()) return;
    let inputEnergy = 0;
    let outputEnergy = 0;
    let playingCount = 0;
    let unknown = false;
    let processed = true;
    let outputPeak = 0;
    const enhancements = [];
    const gains = [];
    const preLimiterGains = [];
    for (const [media, entry] of elements) {
      if (!media.isConnected || media.paused || media.ended) continue;
      playingCount++;
      if (!entry.meter || engine?.state !== 'running' || !entry.meter.stream.getAudioTracks().some(track => track.readyState === 'live' && !track.muted)) {
        unknown = true;
        processed = false;
        continue;
      }
      if (entry.meter.node) {
        if (!entry.meter.verified || !entry.meter.metrics) { unknown = true; processed = false; continue; }
        const metrics = entry.meter.metrics;
        enhancements.push(metrics.enhancement);
        inputEnergy += metrics.inputRms ** 2;
        outputEnergy += (metrics.outputRms * entry.original) ** 2;
        outputPeak += metrics.outputPeak * entry.original;
        gains.push(metrics.gain * entry.original);
        if (Number.isFinite(metrics.limiterReductionDb)) {
          preLimiterGains.push(metrics.gain * entry.original * 10 ** (metrics.limiterReductionDb / 20));
        }
        continue;
      }
      processed = false;
      if (!entry.meter.verified) { unknown = true; continue; }
      const { analyser, samples } = entry.meter;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const rms = Math.sqrt(energy / samples.length);
      inputEnergy += rms * rms;
      outputEnergy += (media.muted ? 0 : rms * media.volume) ** 2;
    }
    return send({ target: 'background', type: 'PAGE_REPORT', data: {
      title: document.title, mediaCount: [...elements.keys()].filter(media => media.isConnected).length,
      playingCount, processed, outputPeak, requiresCapture: false,
      enhancement: !playingCount ? 'idle' : !processed ? 'unavailable'
        : enhancements.length === playingCount && enhancements.every(mode => mode === enhancements[0])
          ? enhancements[0] : 'switching', inputRms: unknown ? null : Math.sqrt(inputEnergy),
      outputRms: unknown ? null : Math.sqrt(outputEnergy),
      minGain: processed && gains.length ? Math.min(...gains) : null,
      maxGain: processed && gains.length ? Math.max(...gains) : null,
      minPreLimiterGain: processed && preLimiterGains.length === playingCount && playingCount ? Math.min(...preLimiterGains) : null,
      maxPreLimiterGain: processed && preLimiterGains.length === playingCount && playingCount ? Math.max(...preLimiterGains) : null,
    } });
  }

  function onMessage(message, sender, respond) {
    const api = runtimeAccess();
    if (!api || sender.id !== api.id || message?.target !== 'automatic') return;
    if (message.type === 'INSPECT') {
      discover(document);
      // Re-register after worker/navigation cleanup, even when the deduplicated
      // media count has not changed. Do not await a queued presence from STATE.
      presence(true);
      // STATE must not read the worker's report map before this message arrives.
      report().then(response => quietly(() => respond({ ok: alive && response?.ok === true })));
      return true;
    }
    update(message);
    quietly(() => respond({ ok: alive }));
  }
  const api = runtimeAccess();
  if (!api) return;
  try { messageEvent = api.runtime.onMessage; messageEvent.addListener(onMessage); }
  catch { dispose(); return; }
  observe(document);
  readSettings();
  startRecovery();
  function onPageShow(event) {
    if (!runtimeAccess()) return;
    documentActive = true;
    if (!ready || settings.autoEnable && !captured) startRecovery();
    for (const [media, entry] of elements) apply(media, entry);
    schedulePresence();
    if (event.persisted) readSettings(true);
  }
  function onPageHide() {
    if (!alive) return;
    documentActive = false;
    clearInterval(recoveryTimer); recoveryTimer = undefined;
    for (const [media, entry] of elements) { rememberVolume(media, entry); release(entry); write(media, entry, nativeVolume(entry)); }
    quiesce();
    clearTimeout(presenceTimer);
    presenceTimer = undefined;
    presence();
  }
  if (alive) {
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
  }
})();
