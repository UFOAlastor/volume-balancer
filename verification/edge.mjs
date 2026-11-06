import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function launchEdge(extensionPath, { profile: existingProfile, extensionId: installedId, locale = process.env.EDGE_UI_LOCALE || 'zh-CN' } = {}) {
  if (existingProfile && extensionPath && !installedId) throw Error('A restart must reuse the installed extension ID without loading it again');
  if (existingProfile && (!path.basename(existingProfile).startsWith('volume-balancer-edge-') ||
      path.dirname(path.resolve(existingProfile)) !== path.resolve(os.tmpdir()))) {
    throw Error('Only disposable volume-balancer-edge-* profiles in the temporary directory are allowed');
  }
  const profile = existingProfile || await mkdtemp(path.join(os.tmpdir(), 'volume-balancer-edge-'));
  const executable = process.env.BROWSER_PATH || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const browser = spawn(executable, [
    '--no-first-run', '--no-default-browser-check',
    ...(locale ? [`--lang=${locale}`, ...(!process.argv.includes('--headless') ? ['-AppleLanguages', `(${locale})`] : [])] : []),
    '--disable-sync', ...(extensionPath ? [`--disable-extensions-except=${path.resolve(extensionPath)}`] : ['--disable-extensions']),
    ...(process.argv.includes('--user-gesture') ? [] : ['--autoplay-policy=no-user-gesture-required']),
    `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--window-size=1100,850', ...(process.argv.includes('--headless') ? ['--headless=new'] : []),
    ...(process.argv.includes('--silent-sink') ? ['--disable-audio-output'] : []),
    ...(process.argv.includes('--mute-output') ? ['--mute-audio'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let logs = '', received = '', id = 0;
  const pending = new Map();
  const events = [];
  browser.stderr.on('data', chunk => { logs += chunk; });
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  browser.on('error', fail);
  browser.on('exit', code => fail(new Error(`Edge exited ${code}: ${logs.slice(-2000)}`)));
  browser.stdio[4].on('data', chunk => {
    received += chunk;
    let index;
    while ((index = received.indexOf('\0')) >= 0) {
      const raw = received.slice(0, index); received = received.slice(index + 1);
      if (!raw) continue;
      const message = JSON.parse(raw), entry = pending.get(message.id);
      if (message.method) {
        events.push(message);
        if (events.length > 2000) events.shift();
      }
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
    }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timeout ${method}: ${logs.slice(-500)}`)); }, 15000);
    pending.set(requestId, { method,
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    browser.stdio[3].write(JSON.stringify({ id: requestId, method, params, sessionId }) + '\0');
  });
  const close = async ({ keepProfile = false } = {}) => {
    if (browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      await cdp('Browser.close').catch(() => browser.kill());
      await exited;
    }
    if (!keepProfile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    const extensionId = installedId || (extensionPath ? (await cdp('Extensions.loadUnpacked', { path: path.resolve(extensionPath) })).id : undefined);
    const version = await cdp('Browser.getVersion');
    // Edge seeds externally configured extensions on a fresh profile. Finish
    // that bootstrap in this disposable profile, then restart with the allowlist
    // applied to the saved registry before creating any test pages.
    if (!existingProfile) {
      await sleep(2000);
      await close({ keepProfile: true });
      return await launchEdge(extensionPath, { profile, extensionId, locale });
    }
    // Do not navigate to an extension URL while startup can still disable/reload
    // it; an error document would remain even after the extension becomes ready.
    await sleep(1500);
    let foreign;
    for (let i = 0; i < 50; i++) {
      foreign = (await cdp('Target.getTargets')).targetInfos.filter(target =>
        target.url.startsWith('chrome-extension://') && !target.url.startsWith(`chrome-extension://${extensionId}/`));
      if (!foreign.length) break;
      await sleep(100);
    }
    if (foreign.length) throw Error('Other extension targets remain in the disposable test profile');
    const attach = async targetId => {
      const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
      const evaluate = async expression => {
        const data = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (data.exceptionDetails) throw Error(JSON.stringify(data.exceptionDetails));
        return data.result.value;
      };
      return { targetId, sessionId, evaluate };
    };
    const page = async url => attach((await cdp('Target.createTarget', { url })).targetId);
    const action = async url => {
      const tab = (await cdp('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find(t => t.url === url);
      if (!tab) throw Error(`Missing tab ${url}`);
      const existing = new Set((await cdp('Target.getTargets')).targetInfos.map(target => target.targetId));
      await cdp('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
      for (let i = 0; i < 40; i++) {
        const popup = (await cdp('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${extensionId}/popup.html` && !existing.has(t.targetId));
        if (popup) return attach(popup.targetId);
        await sleep(100);
      }
      throw Error('Edge did not open extension action popup');
    };
    return { cdp, close, version, extensionId, page, action, attach, profile, executable, events, pid: browser.pid };
  } catch (error) { await close(); throw error; }
}
