import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {launchEdge,sleep} from './edge.mjs';
import {clickControl} from './controls.mjs';
const output=process.env.CONTROL_OUTPUT||'verification-output/control-regression';
const evidence={date:new Date().toISOString(),scope:'Synthetic controls only; this is not media/output evidence'};
let edge,server;
try{
 await mkdir(output,{recursive:true});
 server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<style>html{scroll-behavior:smooth}body{height:4000px}button{position:absolute;top:2000px}</style><button id="control">Control</button><script>window.calls=[];let last=0;control.onclick=e=>{const t=performance.now();if(t-last<200)return;last=t;calls.push({trusted:e.isTrusted,at:t})}</script>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 edge=await launchEdge();const page=await edge.page(`http://127.0.0.1:${server.address().port}/`);await sleep(200);
 const old=await page.evaluate('(()=>{control.scrollIntoView({block:"center"});const r=control.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,height:innerHeight}})()');
 assert.ok(old.y>old.height,'smooth scrolling has not placed the old coordinates in the viewport');
 for(const type of ['mousePressed','mouseReleased'])await edge.cdp('Input.dispatchMouseEvent',{type,x:old.x,y:old.y,button:'left',clickCount:1},page.sessionId);
 assert.equal(await page.evaluate('calls.length'),0);
 await page.evaluate('scrollTo({top:0,behavior:"instant"})');
 const one=await clickControl(edge,page,'#control'),two=await clickControl(edge,page,'#control');
 const calls=await page.evaluate('calls');assert.equal(calls.length,2);assert.ok(calls.every(e=>e.trusted));assert.ok(calls[1].at-calls[0].at>=200);
 evidence.status='passed';evidence.old=old;evidence.newPoints=[one,two];evidence.calls=calls;
 console.log('PASS deterministic input regression: old smooth-scroll coordinates miss; settled hit-tested clicks both reach the control');
}catch(e){evidence.status='failed';evidence.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(edge)await edge.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await writeFile(`${output}/evidence.json`,JSON.stringify(evidence,null,2)+'\n');}
