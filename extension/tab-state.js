export function sanitizeTabControl(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    volume: Number.isFinite(value.volume) ? Math.round(Math.max(0, Math.min(500, value.volume))) : null,
    stopped: value.stopped === true,
  };
}

export function effectiveSettings(settings, control, muted = false) {
  return { ...settings, volume: muted ? 0 : control.volume ?? settings.volume,
    autoEnable: settings.autoEnable && !control.stopped };
}

export function aggregateFrames(frames) {
  const result = { mediaCount: 0, playingCount: 0, inputRms: 0, outputRms: 0, estimated: true, processed: true, outputPeak: 0 };
  let unknown = false;
  for (const frame of frames) {
    if (frame.requiresCapture) result.requiresCapture = true;
    if (frame.playingCount && !frame.processed) result.processed = false;
    result.outputPeak += frame.outputPeak || 0;
    result.mediaCount += frame.mediaCount;
    result.playingCount += frame.playingCount;
    if (frame.playingCount && (frame.inputRms === null || frame.outputRms === null)) unknown = true;
    result.inputRms += (frame.inputRms || 0) ** 2;
    result.outputRms += (frame.outputRms || 0) ** 2;
  }
  const modes = frames.filter(frame => frame.playingCount).map(frame => frame.enhancement);
  result.enhancement = !modes.length ? 'idle' : !result.processed ? 'unavailable'
    : modes.every(mode => mode && mode === modes[0]) ? modes[0] : 'switching';
  result.inputRms = unknown ? null : Math.sqrt(result.inputRms);
  result.outputRms = unknown ? null : Math.sqrt(result.outputRms);
  result.estimated = !result.processed;
  const playing = frames.filter(frame => frame.playingCount);
  const knownGain = playing.length && playing.every(frame => frame.processed &&
    Number.isFinite(frame.minGain) && Number.isFinite(frame.maxGain));
  result.minGain = knownGain ? Math.min(...playing.map(frame => frame.minGain)) : null;
  result.maxGain = knownGain ? Math.max(...playing.map(frame => frame.maxGain)) : null;
  const knownPreLimiterGain = playing.length && playing.every(frame => frame.processed &&
    Number.isFinite(frame.minPreLimiterGain) && Number.isFinite(frame.maxPreLimiterGain));
  result.minPreLimiterGain = knownPreLimiterGain ? Math.min(...playing.map(frame => frame.minPreLimiterGain)) : null;
  result.maxPreLimiterGain = knownPreLimiterGain ? Math.max(...playing.map(frame => frame.maxPreLimiterGain)) : null;
  return result;
}
