export const DEFAULT_SETTINGS = Object.freeze({ volume: 100, normalize: true, autoEnable: true, maxDbfs: -1, enhancement: 'off' });

export function sanitizeSettings(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    // Retired experiment: sanitize on every runtime read and update, not only install.
    enhancement: 'off',
    volume: Number.isFinite(value.volume)
      ? Math.round(Math.min(500, Math.max(0, value.volume)))
      : DEFAULT_SETTINGS.volume,
    normalize: typeof value.normalize === 'boolean' ? value.normalize : DEFAULT_SETTINGS.normalize,
    autoEnable: typeof value.autoEnable === 'boolean' ? value.autoEnable : DEFAULT_SETTINGS.autoEnable,
    maxDbfs: Number.isFinite(value.maxDbfs)
      ? Math.round(Math.max(-60, Math.min(0, value.maxDbfs))) : DEFAULT_SETTINGS.maxDbfs,
  };
}
