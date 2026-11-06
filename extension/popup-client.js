import { t } from './i18n.js';
// Settings are sent immediately; a transport deadline only abandons the reply.
// The worker and audio owner must implement cancellation of capture themselves.
export function createPopupClient({ sendMessage, queryActiveTab, render, onError, timeoutMs = 9000 }) {
  let state, tab, busy = false, polling = false, disposed = false, revision = 0, actionId = 0;
  const pending = new Set(), waits = new Set();
  const report = error => { if (!disposed) onError(error); };
  const emit = () => { if (!disposed && state) render(state, { tab, busy }); };
  function bounded(task, label) {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer); waits.delete(cancel); fn(value);
      };
      const cancel = () => finish(reject, Error(t('text_6561205831')));
      const timer = setTimeout(() => finish(reject, Error(t('text_adf45534c9', [label]))), timeoutMs);
      waits.add(cancel);
      try { Promise.resolve(task()).then(value => finish(resolve, value), error => finish(reject, error)); }
      catch (error) { finish(reject, error); }
    });
  }
  async function request(type, data = {}) {
    const response = await bounded(() => sendMessage({ target: 'background', type, ...data }), type);
    if (!response?.ok) throw Error(response?.error || t('text_8bb2cb84ba'));
    return response.data;
  }
  async function settled() {
    while (pending.size && !disposed) await Promise.all([...pending]);
  }
  const client = {
    settled,
    async loadSettings() {
      const started = revision;
      try {
        const settings = await request('GET_SETTINGS');
        if (!disposed && revision === started && (!state || state.discoveryPending)) {
          state = { ...state, settings, sessions: state?.sessions || [], pages: state?.pages || [], discoveryPending: true };
          emit();
        }
      } catch (error) { report(error); }
    },
    saveSettings(settings) {
      if (disposed) return;
      revision++;
      const sent = request('SETTINGS', { settings }).catch(report).finally(() => pending.delete(sent));
      pending.add(sent);
    },
    async refresh() {
      if (disposed || polling || busy || pending.size) return;
      polling = true;
      const started = revision;
      try {
        const [tabs, result] = await Promise.all([bounded(queryActiveTab, t('text_89d1632412')), request('STATE')]);
        if (!disposed && !busy && revision === started) {
          [tab] = tabs; state = result; emit();
        }
      } catch (error) { report(error); }
      finally { polling = false; }
    },
    async act(type, data) {
      const emergency = type === 'STOP' || type === 'STOP_ALL' || (type === 'TAB_CONTROL' && data?.stopped === true);
      if (disposed || (busy && !emergency)) return;
      const id = ++actionId;
      revision++; busy = true; emit();
      const started = revision;
      try {
        if (!emergency) await settled();
        if (!disposed && id === actionId) {
          const result = await request(type, data);
          if (revision === started && id === actionId) state = result;
        }
      } catch (error) { if (id === actionId) report(error); }
      finally {
        if (id === actionId) {
          busy = false;
          if (revision !== started) {
            await settled();
            await client.refresh();
          } else emit();
        }
      }
    },
    dispose() { disposed = true; for (const cancel of [...waits]) cancel(); },
  };
  return client;
}
