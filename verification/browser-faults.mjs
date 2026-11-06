import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {sleep} from './edge.mjs';
import {launchObservedEdge as launchEdge,automaticWorld,inWorld} from './observer.mjs';
assert.ok(process.argv.includes('--headless')&&process.argv.includes('--silent-sink')&&process.argv.includes('--user-gesture'));
const output=process.env.FAULT_OUTPUT||'verification-output/faults';
const evidence={date:new Date().toISOString(),checks:[],scope:'Digital native WAV and unmodified installed extension. Faults affect only this temporary test page.'};
let edge,server,page;
async function wait(fn,predicate,label,ms=6000){let value;for(const end=Date.now()+ms;Date.now()<end;){try{value=await fn();if(predicate(value))return value;}catch(e){value={error:e.message};}await sleep(80);}throw Error(label+': '+JSON.stringify(value));}
const audible=s=>s.signals.some(p=>p.state==='running'&&p.rms>1e-7);
try {
 await mkdir(output,{recursive:true});
 const n=48000*4,data=Buffer.alloc(44+n*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(96000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)data.writeInt16LE(Math.round(655*Math.sin(i*Math.PI/64)),44+i*2);
 server=createServer((req,res)=>{if(req.url.startsWith('/tone.wav')){res.writeHead(200,{'Content-Type':'audio/wav'});res.end(data);}else{res.setHeader('Content-Type','text/html');res.end('<button id="play">Play</button><audio id="player" loop src="/tone.wav"></audio><script>player.volume=.37;player.addEventListener("volumechange",()=>localStorage.setItem("volume",player.volume));play.onclick=()=>player.play()</script>');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 edge=await launchEdge(process.env.EXTENSION_PATH||'extension');evidence.browser=edge.version;evidence.observation=edge.observation;
 for(const fault of ['lost-metrics','drop-heartbeats','dispose-processor','suspend-context'])for(const intent of ['normal','mute','zero']) {
  page=await edge.page('about:blank');await edge.cdp('Runtime.enable',{},page.sessionId);
  await edge.cdp('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/${fault}-${intent}`},page.sessionId);
  const world=await wait(()=>automaticWorld(edge,page),Number.isInteger,'observer before automatic');
  const read=()=>inWorld(edge,page,world,'audioProbe.snapshot()');
  const point=await page.evaluate('(()=>{const r=play.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
  for(const type of ['mousePressed','mouseReleased'])await edge.cdp('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1},page.sessionId);
  const healthy=await wait(read,s=>s.media[0]?.raw===0&&audible(s),'healthy real output');
  if(intent==='mute')await page.evaluate('player.muted=true');
  if(intent==='zero')await page.evaluate('player.volume=0');
  if(intent!=='normal')await wait(read,s=>!audible(s)&&(intent==='zero'?s.media[0].raw===0:s.media[0].muted),'user silence before fault');
  const injections={
   'lost-metrics':"audioProbe.oldMetrics=audioProbe.nodes.at(-1).port.onmessage;audioProbe.nodes.at(-1).port.onmessage=null",
   'drop-heartbeats':"(()=>{const original=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(m,...args){if(m?.type!=='heartbeat')return original.call(this,m,...args);};})()",
   'dispose-processor':"audioProbe.oldMetrics=audioProbe.nodes.at(-1).port.onmessage;audioProbe.nodes.at(-1).port.postMessage({type:'dispose'})",
   'suspend-context':"audioProbe.contexts.at(-1).suspend()",
  };
  const start=Date.now();await inWorld(edge,page,world,injections[fault]);
  const trace=[];
  const restored=await wait(async()=>{const s=await read();trace.push(s);return s;},s=>{
   const m=s.media[0];return intent==='zero'?m.raw===0&&!audible(s):intent==='mute'?m.muted&&m.raw===.37&&!audible(s):m.raw===.37&&m.lease===null;
  },'fault restores native or preserves user silence',3500);
  const recoveryMs=Date.now()-start;
  await inWorld(edge,page,world,"audioProbe.oldMetrics?.({data:{inputRms:.1,outputRms:.2,gain:2,outputPeak:.3}})");
  await sleep(300);const afterLate=await read();
  if(intent==='mute'){assert.equal(afterLate.media[0].muted,true);assert.ok(!audible(afterLate));}
  if(intent==='zero'){assert.equal(afterLate.media[0].raw,0);assert.ok(!audible(afterLate));}
  if(intent==='normal')assert.ok(afterLate.media[0].raw===.37||audible(afterLate),'late callback cannot leave native suppressed without real output');
  const remembered=await page.evaluate('localStorage.getItem("volume")');
  assert.ok(intent==='zero'?remembered==='0':remembered===null||Number(remembered)>.0);
  evidence.checks.push({fault,intent,recoveryMs,healthy,restored,afterLate,remembered,trace});console.log('PASS',fault,intent,recoveryMs);
  assert.equal(await inWorld(edge,page,world,"audioProbe.events[0].type"),'installed-before-automatic');
  await edge.cdp('Target.closeTarget',{targetId:page.targetId});page=undefined;
 }
 evidence.status='passed-digital-only';
}catch(e){evidence.status='failed';evidence.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(edge)await edge.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await writeFile(`${output}/evidence.json`,JSON.stringify(evidence,null,2)+'\n');}
