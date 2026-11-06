import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir,writeFile } from 'node:fs/promises';
import {sleep} from './edge.mjs';
import {launchObservedEdge as launchEdge,automaticWorld,inWorld} from './observer.mjs';
assert.ok(process.argv.includes('--headless')&&process.argv.includes('--silent-sink')&&process.argv.includes('--user-gesture'));
const output=process.env.REGRESSION_OUTPUT||'verification-output/observer-regression';
let edge,server,page;
const evidence={date:new Date().toISOString(),scope:'Real installed Edge and native decoded WAV. Digital evidence, no human listening.'};
async function wait(fn,predicate,label){let value;for(let i=0;i<100;i++){try{value=await fn();if(predicate(value))return value;}catch(e){value={error:e.message};}await sleep(100);}throw Error(label+': '+JSON.stringify(value));}
try {
 await mkdir(output,{recursive:true});
 const n=48000*4,data=Buffer.alloc(44+n*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(96000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)data.writeInt16LE(Math.round(655*Math.sin(i*Math.PI/64)),44+i*2);
 server=createServer((req,res)=>{if(req.url==='/tone.wav'){res.writeHead(200,{'Content-Type':'audio/wav'});res.end(data);}else{res.setHeader('Content-Type','text/html');res.end('<button id="play">Play</button><audio id="player" loop src="/tone.wav"></audio><script>player.volume=.37;play.onclick=()=>player.play()</script>');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 edge=await launchEdge(process.env.EXTENSION_PATH||'extension');evidence.browser=edge.version;evidence.observation=edge.observation;
 page=await edge.page('about:blank');await edge.cdp('Runtime.enable',{},page.sessionId);
 await edge.cdp('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`},page.sessionId);
 const world=await wait(()=>automaticWorld(edge,page),Number.isInteger,'early observer');
 const pos=await page.evaluate('(()=>{const r=play.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
 for(const type of ['mousePressed','mouseReleased'])await edge.cdp('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1},page.sessionId);
 const before=await wait(()=>inWorld(edge,page,world,'audioProbe.snapshot()'),s=>s.media[0]?.raw===0&&s.signals.some(p=>p.rms>.001),'real output before late observer');
 await inWorld(edge,page,world,`(()=>{const connect=AudioNode.prototype.connect;globalThis.latePoints=[];AudioNode.prototype.connect=function(d,...args){const r=connect.call(this,d,...args);if(d===this.context.destination)latePoints.push(this);return r;};})()`);
 await sleep(700);
 const compare=await inWorld(edge,page,world,'({snapshot:audioProbe.snapshot(),lateCount:latePoints.length,events:audioProbe.events})');
 assert.ok(compare.snapshot.signals.some(p=>p.rms>.001));assert.equal(compare.lateCount,0,'late-only checker deterministically misses an already connected output');
 assert.ok(compare.snapshot.media[0].time>before.media[0].time+.5);
 assert.equal(compare.events[0].type,'installed-before-automatic');

 assert.equal(await Promise.race([inWorld(edge,page,world,'debugger;true'),sleep(1000).then(()=>false)]),true,
   'observer must not keep a debugger attached that can stop unrelated page code');
 evidence.status='passed';evidence.before=before;evidence.compare=compare;evidence.observerBoot=compare.events[0];
 console.log('PASS deterministic false-negative: late probe has zero observed connections while real output and native clock continue');
 await edge.cdp('Debugger.enable',{},page.sessionId);
 const prior=new Set(edge.events);
 const pausedRequest=inWorld(edge,page,world,'debugger;true');
 const paused=await wait(async()=>edge.events.findLast(e=>!prior.has(e)&&e.sessionId===page.sessionId&&e.method==='Debugger.paused'),Boolean,'explicit page freeze');
 await sleep(1700);
 const readFrozen=await edge.cdp('Debugger.evaluateOnCallFrame',{callFrameId:paused.params.callFrames[0].callFrameId,
   expression:'audioProbe.snapshot()',returnByValue:true},page.sessionId);
 if(readFrozen.exceptionDetails)throw Error(JSON.stringify(readFrozen.exceptionDetails));
 const frozen=readFrozen.result.value;
 assert.equal(frozen.media[0].raw,0,'no page code can restore the native volume while all page JS is paused');
 assert.ok(JSON.parse(frozen.media[0].lease).until<frozen.at,'recovery lease has expired while the page is unable to execute');
 await edge.cdp('Debugger.resume',{},page.sessionId);await pausedRequest;
 const resumed=await wait(()=>inWorld(edge,page,world,'audioProbe.snapshot()'),s=>s.media[0].raw===.37,'recovery once page code runs again');
 evidence.freezeBoundary={kind:'All page JavaScript paused for 1700ms, then resumed; not an OS kill test',frozen,resumed};
 await edge.cdp('Debugger.disable',{},page.sessionId);
 console.log('PASS boundary demonstrated: expired lease cannot restore while page JS is frozen; native volume restores after resume');
 await edge.cdp('Debugger.enable',{},page.sessionId);
 const oldLoader=(await edge.cdp('Page.getFrameTree',{},page.sessionId)).frameTree.frame.loaderId;
 await edge.cdp('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/persistent-variant`},page.sessionId);
 await wait(async()=>(await edge.cdp('Page.getFrameTree',{},page.sessionId)).frameTree.frame.loaderId,v=>v&&v!==oldLoader,'new fixture document committed');
 const persistentWorld=await wait(()=>automaticWorld(edge,page),Number.isInteger,'persistent observer control');
 const previousPauses=new Set(edge.events);
 let completed=false;
 const held=inWorld(edge,page,persistentWorld,'debugger;true').then(value=>{completed=true;return value;});
 const blocked=await wait(async()=>edge.events.findLast(e=>!previousPauses.has(e)&&e.sessionId===page.sessionId&&e.method==='Debugger.paused'),Boolean,'persistent debugger pauses unrelated fixture code');
 assert.equal(completed,false);
 evidence.persistentDebuggerControl={blockedBeforeDetach:true,reason:blocked.params.reason,scope:'Explicit debugger statement in our own fixture, no website safeguard bypass'};
 await edge.cdp('Debugger.disable',{},page.sessionId);assert.equal(await held,true);
 evidence.persistentDebuggerControl.completedAfterDetach=completed;
 console.log('PASS deterministic debugger-lifetime control: persistent variant blocks fixture code; automatic detach avoids it');
}catch(e){evidence.status='failed';evidence.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(edge){if(evidence.status==='failed')await edge.cdp('Debugger.resume',{},page?.sessionId).catch(()=>{});await edge.close();}if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await writeFile(`${output}/evidence.json`,JSON.stringify(evidence,null,2)+'\n');}
