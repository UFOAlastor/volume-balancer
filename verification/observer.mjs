import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { launchEdge } from './edge.mjs';

async function tree(root,prefix='') {
  const result=new Map();
  for(const entry of await readdir(root,{withFileTypes:true})) {
    const name=prefix+entry.name,location=path.join(root,entry.name);
    if(entry.isDirectory())for(const [k,v]of await tree(location,name+'/'))result.set(k,v);
    else if(entry.isFile())result.set(name,await readFile(location));
    else throw Error('Only regular extension files can be verified');
  }
  return result;
}

export async function launchObservedEdge(source='extension') {
  const before=await tree(source), manifest=JSON.parse(before.get('manifest.json'));
  const directory=await mkdtemp(path.join(os.tmpdir(),'volume-balancer-observed-source-'));
  let edge;
  try {
    await cp(source,directory,{recursive:true});
    const filename='verification-observer.js';assert.ok(!before.has(filename));
    const probe=await readFile(new URL('./observer.js',import.meta.url));
    await writeFile(path.join(directory,filename),probe);
    const groups=manifest.content_scripts.filter(g=>g.js.includes('automatic.js'));
    assert.equal(groups.length,1);assert.equal(groups[0].run_at,'document_start');
    groups[0].js.unshift(filename);
    await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
    const after=await tree(directory);
    for(const [name,data]of before)if(name!=='manifest.json')assert.ok(data.equals(after.get(name)),name);
    const normalized=JSON.parse(after.get('manifest.json'));
    normalized.content_scripts.find(g=>g.js.includes('automatic.js')).js.shift();
    assert.deepEqual(normalized,JSON.parse(before.get('manifest.json')),'Only the test observer may change the test manifest');
    edge=await launchEdge(directory);assert.match(edge.version.product,/^Edg\//);
    const close=edge.close;
    edge.close=async()=>{try{await close();}finally{await rm(directory,{recursive:true,force:true});}};
    edge.observation={mode:'Test-only copy with one observer prepended at document_start; no debugger attached',
      originalVersion:manifest.version,originalFileCount:before.size,
      unchangedProgramAndResourceFiles:before.size-1,permissions:manifest.permissions,
      originalHashes:Object.fromEntries([...before].map(([n,d])=>[n,createHash('sha256').update(d).digest('hex')])),
      observerSha256:createHash('sha256').update(probe).digest('hex'),
      manifestChange:'One additional isolated test script before automatic.js; every other field unchanged'};
    return edge;
  }catch(error){if(edge)await edge.close();await rm(directory,{recursive:true,force:true});throw error;}
}

export async function automaticWorld(edge,page) {
  const frame=(await edge.cdp('Page.getFrameTree',{},page.sessionId)).frameTree.frame.id;
  const contexts=edge.events.filter(e=>e.sessionId===page.sessionId&&e.method==='Runtime.executionContextCreated'&&
    e.params.context.origin===`chrome-extension://${edge.extensionId}`&&e.params.context.auxData?.frameId===frame&&e.params.context.auxData?.isDefault===false);
  for(const e of contexts.reverse())try {
    const id=e.params.context.id;
    if(await inWorld(edge,page,id,'Boolean(globalThis.audioProbe)'))return id;
  }catch{}
}

export async function inWorld(edge,page,contextId,expression) {
  const reply=await edge.cdp('Runtime.evaluate',{contextId,expression,awaitPromise:true,returnByValue:true},page.sessionId);
  if(reply.exceptionDetails)throw Error(JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
