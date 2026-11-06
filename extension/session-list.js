import { t } from './i18n.js';
export function describeSession(session, settings) {
  const mode = session.mode === 'capture' ? t('text_eca2d8b4d9') : t('text_f7eacc50af');
  const status = session.stopped ? t('text_f006455e3b') : session.muted ? t('text_e5e4686f65') : session.requiresCapture ? t('text_7674c9831c') : session.volume === 0 ? t('text_c74861e309')
    : session.playingCount === 0 || session.inputRms === 0 ? t('text_8b820cb9de')
      : !Number.isFinite(session.inputRms) ? t('text_c1467a276c') : t('text_e6666b2eb3');
  return {
    detail: `${mode} · ${status}${session.followsGlobal ? t('globalDetail') : t('independentDetail')}`,
    cap: session.stopped ? t('text_b2299759c5')
      : session.captureError ? session.captureError
      : session.mode === 'capture' && session.processed === false ? t('text_8458e96a97')
      : session.requiresCapture ? t('text_8a41ea947d', [session.volume])
      : !session.processed && session.volume > 100 ? t('text_93cb6f56b9')
      : !Number.isFinite(session.inputRms) ? t('text_572fd6ce2e')
        : session.playingCount === 0 ? t('text_8b820cb9de')
          : session.mode === 'capture' || session.processed ? t('text_c715688ec8') : t('text_8c3e139f89'),
  };
}

// Key rows by tab ID: polling must preserve focus. Each listener reads the
// latest snapshot, rather than closing over an old mute/stop.
export function createSessionList(container, onAction) {
  const document = container.ownerDocument;
  const rows = new Map();
  function createRow(session) {
    const row = document.createElement('article');
    row.className = 'session'; row.dataset.id = session.tabId;
    // Static markup only; titles and all other page data use textContent below.
    row.innerHTML = `<div class="session-info"><h3 class="session-title"></h3><p class="session-detail"></p><p class="session-availability" role="status" hidden></p></div>
      <div class="session-actions"></div>`;
    const get = selector => row.querySelector(selector);
    const entry = { row, session, get };
    const button = (name, text, control) => {
      const element = document.createElement('button');
      element.type = 'button'; element.className = `stop ${name}`; element.textContent = text;
      element.addEventListener('click', () => onAction('TAB_CONTROL', { tabId: entry.session.tabId, ...control(entry.session) }));
      return element;
    };
    const value = document.createElement('span'); value.className = 'tab-volume';
    get('.session-actions').append(
      button('mute', t('mute'), page => ({ muted: !page.muted })),
      button('lower', '−', () => ({ delta: -10 })), value,
      button('higher', '+', () => ({ delta: 10 })),
      button('follow-global', t('text_0268c087bc'), () => ({ volume: null })),
      button('stop-toggle', t('stop'), page => ({ stopped: !page.stopped })),
    );
    container.append(row);
    return entry;
  }
  return {
    render(pages, settings, busy) {
      const ids = new Set(pages.map(page => page.tabId));
      for (const [id, entry] of rows) if (!ids.has(id)) { entry.row.remove(); rows.delete(id); }
      container.querySelector('.empty')?.remove();
      if (!pages.length) {
        const empty = document.createElement('p'); empty.className = 'empty';
        empty.textContent = t('text_90bbc5fd2b'); container.append(empty);
      }
      for (const session of pages) {
        const entry = rows.get(session.tabId) || createRow(session);
        rows.set(session.tabId, entry); entry.session = session;
        const { row, get } = entry;
        const view = describeSession(session, settings);
        get('.session-title').textContent = session.title; get('.session-title').title = session.title;
        get('.session-detail').textContent = view.detail;
        get('.session-detail').title = view.cap;
        get('.session-availability').textContent = view.cap;
        get('.session-availability').hidden = session.stopped || !(session.captureError || session.requiresCapture || session.processed === false);
        get('.mute').textContent = session.muted ? t('unmute') : t('mute');
        get('.mute').setAttribute('aria-pressed', String(session.muted));
        get('.mute').setAttribute('aria-label', t('actionForPage', [session.muted ? t('unmute') : t('mute'), session.title]));
        get('.tab-volume').textContent = `${session.volume}%`;
        get('.lower').setAttribute('aria-label', t('text_7b98aaf973', [session.title]));
        get('.higher').setAttribute('aria-label', t('text_5beee343af', [session.title]));
        get('.follow-global').setAttribute('aria-label', t('text_969e7e2dd5', [session.title]));
        get('.stop-toggle').textContent = session.stopped ? t('resume') : t('stop');
        get('.stop-toggle').setAttribute('aria-label', t('actionForPage', [session.stopped ? t('resume') : t('stop'), session.title]));
        row.querySelectorAll('button').forEach(button => { button.disabled = busy; });
        get('.lower').disabled = busy || session.volume <= 0 || session.stopped;
        get('.higher').disabled = busy || session.volume >= 500 || session.stopped;
        get('.follow-global').disabled = busy || session.followsGlobal;
        if (session.mode === 'automatic' && !settings.autoEnable) {
          get('.stop-toggle').textContent = t('text_0f4669c080'); get('.stop-toggle').disabled = true;
        }
      }
    },
  };
}
