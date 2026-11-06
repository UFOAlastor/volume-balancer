import { launchObservedEdge as launchEdge,automaticWorld } from './observer.mjs';
import {clickControl} from './controls.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { sleep } from './edge.mjs';
assert.ok(process.argv.includes('--headless') && process.argv.includes('--silent-sink') && process.argv.includes('--user-gesture'));
const output = process.env.SITES_EVIDENCE || 'verification-output/real-sites';
const sites = [
  { name: 'bilibili', url: process.env.BILIBILI_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7/', play: '.bpx-player-ctrl-play', mute: '.bpx-player-ctrl-volume' },
  { name: 'youtube', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', play: '.ytp-play-button', mute: '.ytp-mute-button' },
  { name: 'w3schools', url: 'https://www.w3schools.com/html/mov_bbb.mp4', play: 'video,audio' },
].filter(s => !process.env.SITE_NAMES || process.env.SITE_NAMES.split(',').includes(s.name));
const evidence = { date: new Date().toISOString(), sites: [],
  limitations: ['Normal autoplay; trusted controls on anonymous public pages; no extension action or page before first processing',
    'Fake hardware sink and digital destination analyser, not acoustic recording or human listening',
    'No login, challenge bypass, proxy changes, browser installation, personal profile or system volume changes'] };
let edge;
async function wait(task, predicate, label, ms = 12000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end;) {
    try { last = await task(); if (predicate(last)) return last; } catch (e) { last = { error: e.message }; }
    await sleep(200);
  }
  throw Error(`${label}: ${JSON.stringify(last)}`);
}
const native = page => page.evaluate(`Array.from(document.querySelectorAll('audio,video'),m=>({volume:m.volume,muted:m.muted,paused:m.paused,time:m.currentTime,ready:m.readyState,error:m.error?.message,source:m.currentSrc.startsWith('blob:')?'MSE/blob':m.currentSrc.split('?')[0]}))`);
const memory = page => page.evaluate(`(()=>{const out={};const visit=(v,path,depth=0)=>{if(depth>5)return;
  if(typeof v==='string'){try{visit(JSON.parse(v),path,depth+1)}catch{};return;}
  if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){
    if(/volume|muted/i.test(k)&&(typeof x==='number'||typeof x==='boolean'))out[path+'.'+k]=x;
    else visit(x,path+'.'+k,depth+1);}};
  for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(/volume|bpx|player/i.test(k)){
    try{visit(JSON.parse(localStorage.getItem(k)),k)}catch{}}}return out;})()`);
async function click(page, selector, nativeControl = false) {
  return clickControl(edge,page,selector,{nativeControl});
}
async function isolated(page, contextId, expression) {
  const r = await edge.cdp('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, page.sessionId);
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
}
try {
  await mkdir(output, { recursive: true });
  for (const site of sites) {
    const result = { name: site.name, url: site.url, actions: [], status: 'running' }; evidence.sites.push(result);
    let page;
    try {
      edge = await launchEdge(process.env.EXTENSION_PATH || 'extension'); evidence.browser = edge.version;
      const workerInfo = await wait(async () => (await edge.cdp('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${edge.extensionId}/background.js`),Boolean,'extension ready before site');
      const worker = await edge.attach(workerInfo.targetId);
      await worker.evaluate(`globalThis.siteReports={};globalThis.siteTabs={};chrome.runtime.onMessage.addListener((m,s)=>{
        if(s.tab&&s.frameId===0)siteTabs[s.tab.id]={id:s.tab.id,url:s.url};
        if(m.type==='PAGE_REPORT'&&s.tab)siteReports[s.tab.id+':'+s.frameId]={...m.data,tabId:s.tab.id,frameId:s.frameId};});true`);
      page = await edge.page('about:blank'); await edge.cdp('Page.enable', {}, page.sessionId); await edge.cdp('Runtime.enable', {}, page.sessionId);
      const navigation = await edge.cdp('Page.navigate', { url: site.url }, page.sessionId); result.navigation = navigation;
      if (navigation.errorText) throw Error(navigation.errorText);
      result.initial = await wait(() => native(page), ms => ms.some(m => m.ready >= 3), 'real site decoder', 45000);
      let world = await wait(() => automaticWorld(edge,page), Number.isInteger, 'observed isolated audio world');
      await isolated(page,world,'globalThis.sitePCM=audioProbe.points;true');
      const id = await wait(() => worker.evaluate(`Object.values(siteTabs).find(t=>t.url.startsWith(${JSON.stringify(site.url.split('?')[0])}))?.id`), Number.isInteger, 'site tab ID');
      const reports = async () => {
        await worker.evaluate(`chrome.tabs.sendMessage(${id},{target:'automatic',type:'INSPECT'}).catch(()=>null)`); await sleep(100);
        return worker.evaluate(`Object.values(siteReports).filter(r=>r.tabId===${id})`);
      };
      result.beforeControls = await reports();
      for (const [field, selector] of [['muted', site.mute], ['paused', site.play]]) {
        const current = await native(page);
        if (current[0]?.[field] && selector) {
          await click(page, selector, site.name === 'w3schools'); result.actions.push({ field, selector, method: 'trusted site/native control click' }); await sleep(500);
        }
      }
      await wait(() => native(page), ms => ms.some(m => !m.paused && !m.muted && m.time > .3), 'site playing through normal controls');
      result.firstProcessed = await wait(reports, rs => rs.some(r => r.processed && r.inputRms > 1e-7 && r.outputRms > 1e-7), 'no-popup real site processed output', 18000);
      const targets = (await edge.cdp('Target.getTargets')).targetInfos;
      assert.deepEqual(targets.filter(t => t.type === 'page' && t.url.startsWith('chrome-extension://')), []);
      assert.deepEqual(await worker.evaluate('chrome.tabCapture.getCapturedTabs()'), []);
      result.native = await native(page);
      result.destination = await isolated(page, world, `sitePCM.filter(p=>p.connected).map(p=>{const x=new Float32Array(p.analyser.fftSize);p.analyser.getFloatTimeDomainData(x);
        return {rms:Math.sqrt(x.reduce((s,v)=>s+v*v,0)/x.length),gate:p.source.gain?.value,state:p.source.context.state};})`);
      if (!result.destination.length && site.name === 'w3schools') {
        await click(page,site.play,true);await wait(()=>native(page),ms=>ms[0]?.paused,'native site pause');
        await click(page,site.play,true);
        result.destination=await wait(()=>isolated(page,world,`sitePCM.filter(p=>p.connected).map(p=>{const x=new Float32Array(p.analyser.fftSize);p.analyser.getFloatTimeDomainData(x);
          return {rms:Math.sqrt(x.reduce((s,v)=>s+v*v,0)/x.length),gate:p.source.gain?.value,state:p.source.context.state};})`),ps=>ps.some(p=>p.rms>1e-7),'native site resume destination PCM');
        result.actions.push({method:'trusted native pause/resume after initial automatic report; attach destination observer to rebuilt graph'});
      }
      result.rawVolume = await isolated(page, world, `Array.from(document.querySelectorAll('audio,video'),m=>m.volume)`);
      result.tab = await worker.evaluate(`chrome.tabs.get(${id}).then(t=>({audible:t.audible,muted:t.mutedInfo?.muted}))`);
      result.rememberedBefore = await memory(page);
      if (process.argv.includes('--interactions') && site.name !== 'w3schools') {
        result.interactions=[];
        const raw = () => isolated(page, world, `document.querySelector('audio,video').volume`);
        const samples = () => isolated(page,world,`sitePCM.filter(p=>p.connected&&p.source.context.state==='running').map(p=>{const x=new Float32Array(p.analyser.fftSize);p.analyser.getFloatTimeDomainData(x);return Math.sqrt(x.reduce((s,v)=>s+v*v,0)/x.length)})`);
        await click(page,site.play);
        await wait(()=>native(page),ms=>ms[0]?.paused,'site pause');
        await wait(raw,v=>v>0,'paused site native restoration');result.interactions.push({mode:'pause',media:await native(page),rawVolume:await raw()});
        await click(page,site.play);await wait(()=>native(page),ms=>!ms[0]?.paused,'site resume control actuated');await wait(samples,ss=>ss.some(s=>s>1e-7),'site resume destination PCM');
        const hover=await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(site.mute)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await edge.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...hover,button:'none'},page.sessionId);await sleep(500);
        result.volumeControls=await page.evaluate(`Array.from(document.querySelectorAll('[class*=volume]'),e=>({class:e.className,role:e.getAttribute('role'),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})).filter(e=>e.width&&e.height)`);
        const selector=site.name==='youtube'?'.ytp-volume-slider':'.bpx-player-ctrl-volume-box .bui-bar-wrap';
        const bounds=await wait(()=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()`),Boolean,'real site volume slider');
        const vertical=site.name==='bilibili';
        const point=t=>vertical?{x:bounds.x+bounds.w/2,y:bounds.y+bounds.h*(1-t)}:{x:bounds.x+bounds.w*t,y:bounds.y+bounds.h/2};
        await edge.cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point(.6),button:'left',buttons:1,clickCount:1},page.sessionId);
        for(let i=0;i<=6;i++)await edge.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...point(.6-i*.03),button:'left',buttons:1},page.sessionId);
        await edge.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point(.42),button:'left',clickCount:1},page.sessionId);
        await sleep(600);
        const changed=(await native(page))[0].volume;assert.ok(changed>0&&changed<.9,'real volume drag changed player intent');
        result.interactions.push({mode:'trusted volume drag',volume:changed,memory:await memory(page),rawVolume:await raw()});
        await click(page,site.mute);await wait(()=>native(page),ms=>ms[0]?.muted||ms[0]?.volume===0,'site mute or explicit zero');
        await wait(samples,ss=>ss.every(s=>s<1e-7),'site mute has zero destination PCM');
        result.interactions.push({mode:'mute',media:await native(page),memory:await memory(page)});
        await click(page,site.mute);await wait(samples,ss=>ss.some(s=>s>1e-7),'site unmute destination PCM');
        assert.ok(Math.abs((await native(page))[0].volume-changed)<.03);
        const controller=await edge.page(`chrome-extension://${edge.extensionId}/popup.html`);
        await wait(()=>controller.evaluate('Boolean(document.querySelector("#volume"))'),Boolean,'post-acceptance control');
        const response=await controller.evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{autoEnable:false}})");assert.ok(response.ok);
        await wait(raw,v=>Math.abs(v-changed)<.03,'real site stop restores raw volume');
        result.interactions.push({mode:'automatic off',rawVolume:await raw(),media:await native(page),memory:await memory(page)});
        await controller.evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{autoEnable:true}})");
        await edge.cdp('Target.closeTarget',{targetId:controller.targetId});await wait(samples,ss=>ss.some(s=>s>1e-7),'real site automatic restart');
        if(process.argv.includes('--switch-video')) {
          const switchedURL=site.name==='youtube'?'https://www.youtube.com/watch?v=eRsGyueVLvQ':'https://www.bilibili.com/video/BV1tCxh6vEU4/';
          const oldLoader=(await edge.cdp('Page.getFrameTree',{},page.sessionId)).frameTree.frame.loaderId;
          await edge.cdp('Page.navigate',{url:switchedURL},page.sessionId);
          await wait(async()=>(await edge.cdp('Page.getFrameTree',{},page.sessionId)).frameTree.frame.loaderId,v=>v&&v!==oldLoader,'different video document committed',45000);
          const current=await wait(()=>native(page),ms=>ms.some(m=>m.ready>=3),'different video decoder',45000);
          world=await wait(()=>automaticWorld(edge,page),Number.isInteger,'different video observed isolated world');
          await isolated(page,world,'globalThis.sitePCM=audioProbe.points;true');
          for(const[field,selector]of[['muted',site.mute],['paused',site.play]])if((await native(page))[0]?.[field])await click(page,selector);
          await wait(samples,ss=>ss.some(s=>s>1e-7),'different video actual destination PCM');
          assert.ok(Math.abs((await native(page))[0].volume-changed)<.03,'different video retained user volume');
          result.interactions.push({mode:'different video with extension active',url:switchedURL,initial:current,media:await native(page),memory:await memory(page),rawVolume:await raw()});
        }
        result.probeBeforeUninstall=await isolated(page,world,'({snapshot:audioProbe.snapshot(),events:audioProbe.events})');
        await worker.evaluate('setTimeout(()=>chrome.management.uninstallSelf({showConfirmDialog:false}),50);true');
        await wait(raw,v=>Math.abs(v-changed)<.03,'real site uninstall restores raw volume');
        result.interactions.push({mode:'uninstall',rawVolume:await raw(),media:await native(page),memory:await memory(page)});
        const oldLoader=(await edge.cdp('Page.getFrameTree',{},page.sessionId)).frameTree.frame.loaderId;
        await edge.cdp('Page.reload',{},page.sessionId);
        const newLoader=await wait(async()=>(await edge.cdp('Page.getFrameTree',{},page.sessionId)).frameTree.frame.loaderId,v=>v&&v!==oldLoader,'real site refresh committed',45000);
        const reloaded=await wait(()=>native(page),ms=>ms.some(m=>m.ready>=3),'real site refresh after uninstall',45000);
        assert.ok(Math.abs(reloaded[0].volume-changed)<.03,'website did not retain latest user volume after uninstall/refresh');
        result.interactions.push({mode:'refresh after uninstall',oldLoader,newLoader,media:reloaded,memory:await memory(page)});
      }
      result.observation=edge.observation;
      result.status = result.destination.some(p => p.rms > 1e-7) ? 'passed-digital-first-play' : 'processed-report-only-destination-not-observed';
      console.log(result.status, site.name);
    } catch (error) {
      result.status = 'failed-or-blocked'; result.error = error.stack; console.error(site.name, error.message);
      result.observation=edge?.observation;
      try { result.failure = { media: await native(page), pageText: await page.evaluate('document.body.innerText.slice(0,1400)'),
        decoder:await page.evaluate(`Array.from(document.querySelectorAll('audio,video'),m=>({time:m.currentTime,duration:m.duration,network:m.networkState,seeking:m.seeking,rate:m.playbackRate,buffered:Array.from({length:m.buffered.length},(_,i)=>[m.buffered.start(i),m.buffered.end(i)]),lease:m.getAttribute('data-volume-balancer-lease')}))`) }; } catch {}
    } finally {
      if (page) try { const shot = await edge.cdp('Page.captureScreenshot', { format: 'png' }, page.sessionId); await writeFile(`${output}/${site.name}.png`, Buffer.from(shot.data, 'base64')); } catch {}
      if (edge) await edge.close(); edge = undefined;
      await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
    }
  }
  evidence.status = evidence.sites.every(s => s.status === 'passed-digital-first-play') ? 'passed-digital-only' : 'incomplete';
  if (evidence.status !== 'passed-digital-only') process.exitCode = 1;
} finally {
  if (edge) await edge.close();
  await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
}
