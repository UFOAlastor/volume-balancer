import {sleep} from './edge.mjs';
const lastClick=new WeakMap();
export async function clickControl(edge,page,selector,{nativeControl=false}={}) {
  let point,last;
  await sleep(Math.max(0,300-(Date.now()-(lastClick.get(page)||0))));
  for(const end=Date.now()+8000;Date.now()<end;) {
    last=await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return;
      e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();
      return r.width&&r.height?{x:r.x+${nativeControl?'20':'r.width/2'},y:r.y+${nativeControl?'r.height-27':'r.height/2'}}:null})()`);
    if(last) {
      await edge.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...last,button:'none'},page.sessionId);
      await sleep(150);
      point=await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return;
        const r=e.getBoundingClientRect(),x=r.x+${nativeControl?'20':'r.width/2'},y=r.y+${nativeControl?'r.height-27':'r.height/2'},h=document.elementFromPoint(x,y);
        return r.width&&r.height&&h&&(h===e||e.contains(h))?{x,y}:null})()`);
      if(point)break;
    }
    await sleep(100);
  }
  if(!point)throw Error('Control is not hittable: '+selector+' '+JSON.stringify(last));
  await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});globalThis.__volumeBalancerVerificationClick={trusted:false};
    const handler=event=>{if(event.composedPath().includes(e)){__volumeBalancerVerificationClick.trusted=event.isTrusted;document.removeEventListener('click',handler,true);}};
    document.addEventListener('click',handler,true);})()`);
  for(const type of ['mousePressed','mouseReleased'])await edge.cdp('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1},page.sessionId);
  lastClick.set(page,Date.now());
  let delivered=false;
  for(const end=Date.now()+2000;Date.now()<end;) {
    if(await page.evaluate('__volumeBalancerVerificationClick.trusted')){delivered=true;break;}
    await sleep(20);
  }
  if(!delivered)throw Error('Trusted click did not reach control: '+selector);
  return point;
}
