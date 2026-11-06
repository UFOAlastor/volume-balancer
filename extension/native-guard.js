(() => {
  // This small guard runs in the page world, independently of the extension's
  // runtime. A killed/invalidated content script cannot renew a playback lease.
  const LEASE = 'data-volume-balancer-lease', ACK = 'data-volume-balancer-ack';
  const INTENT = 'data-volume-balancer-intent';
  const CONTROL = 'data-volume-balancer-control';
  const leases = new Map();
  const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const nativeVolume = media => volume.get.call(media);
  let timer;
  function forget(media) {
    leases.delete(media);
    media.removeAttribute(LEASE); media.removeAttribute(ACK);
    if (!leases.size) { clearInterval(timer); timer = undefined; }
  }
  function restore(media, lease) {
    media.dispatchEvent(new Event('volume-balancer-expired', { bubbles: true, composed: true }));
    forget(media);
    // A new nonzero player choice or explicit zero intent always wins.
    if (nativeVolume(media) === 0 && media.getAttribute(INTENT) !== '0') {
      try { volume.set.call(media, lease.volume); } catch { /* Continue restoring other players. */ }
    }
  }
  function expire() {
    for (const [media, lease] of leases) {
      if (!media.isConnected || performance.now() >= lease.until) restore(media, lease);
      else if (nativeVolume(media) !== 0) forget(media);
    }
  }
  window.addEventListener('volume-balancer-lease', event => {
    const media = event.composedPath()[0];
    if (!(media instanceof HTMLMediaElement)) return;
    try {
      const lease = JSON.parse(media.getAttribute(LEASE));
      const now = performance.now();
      if (!Number.isFinite(lease.volume) || lease.volume <= 0 || lease.volume > 1 ||
          !Number.isFinite(lease.until) || lease.until <= now || lease.until > now + 2000) return;
      leases.set(media, { ...lease, muted: media.muted });
      media.setAttribute(ACK, media.getAttribute(LEASE));
      timer ||= setInterval(expire, 250);
    } catch { /* Malformed page data cannot claim a restoration lease. */ }
  }, true);
  window.addEventListener('volumechange', event => {
    const media = event.composedPath()[0], lease = leases.get(media);
    if (!lease) return;
    if (nativeVolume(media) !== 0) { forget(media); return; }
    if (media.muted !== lease.muted) { restore(media, lease); return; }
    // Do not let websites persist our private suppression as a user choice.
    // Real mute changes and nonzero player adjustments remain visible.
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('pagehide', () => {
    for (const [media, lease] of leases) restore(media, lease);
  }, true);
  // Native controls read the underlying zero, not the page-world getter. Give
  // them real native volume before their default action, and temporarily yield
  // processing so a drag/key to zero is observable rather than a no-op setter.
  const control = event => {
    if (!event.isTrusted) return;
    const media = event.composedPath().find(node => node instanceof HTMLMediaElement);
    if (!media?.controls || (!leases.has(media) && !media.hasAttribute(CONTROL))) return;
    if (event.type === 'pointermove' && !event.buttons) return;
    media.setAttribute(CONTROL, String(performance.now() + 1200));
    const lease = leases.get(media);
    if (lease) restore(media, lease);
    media.dispatchEvent(new Event('volume-balancer-control', { bubbles: true, composed: true }));
  };
  for (const name of ['pointerdown', 'pointermove', 'keydown']) window.addEventListener(name, control, true);
  if (volume?.configurable && volume.set) Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    ...volume,
    get() {
      const raw = volume.get.call(this), lease = leases.get(this);
      // A site's target listener may run after the isolated controller has
      // already suppressed the new user value. Preserve that value on page
      // reads too, including unrelated player persistence events.
      return raw === 0 && lease && this.getAttribute(LEASE) ? lease.volume : raw;
    },
    set(value) {
      const explicitZero = leases.has(this) && Number(value) === 0;
      const unchanged = nativeVolume(this) === 0;
      volume.set.call(this, value);
      if (explicitZero) {
        forget(this); this.setAttribute(INTENT, '0');
        // Native setters emit no volumechange when already at zero. Tell the
        // isolated controller about this explicit website/player zero anyway.
        this.dispatchEvent(new Event('volume-balancer-intent', { bubbles: true, composed: true }));
        if (unchanged) this.dispatchEvent(new Event('volumechange'));
      }
    },
  });
})();
