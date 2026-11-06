(()=>{
    if(globalThis.audioProbe)return;
    const connect=AudioNode.prototype.connect,disconnect=AudioNode.prototype.disconnect;
    const volume=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'volume');
    const p=globalThis.audioProbe={points:[],nodes:[],contexts:[],events:[]};
    const log=(type,data={})=>{p.events.push({at:performance.now(),type,...data});if(p.events.length>1200)p.events.shift();};
    AudioNode.prototype.connect=function(d,...args){const result=connect.call(this,d,...args);
      if(!p.contexts.includes(this.context))p.contexts.push(this.context);
      if(this instanceof AudioWorkletNode&&!p.nodes.includes(this)){
        p.nodes.push(this);this.port.addEventListener('message',({data})=>log('metrics',{input:data.inputRms,output:data.outputRms}));
      }
      if(d===this.context.destination){const analyser=this.context.createAnalyser();analyser.fftSize=8192;
        connect.call(this,analyser);p.points.push({source:this,analyser,connected:true});log('destination-connected');}
      return result;
    };
    AudioNode.prototype.disconnect=function(...args){for(const x of p.points)if(x.source===this)x.connected=false;return disconnect.apply(this,args);};
    for(const type of ['play','pause','ended','loadedmetadata','emptied','volume-balancer-expired'])document.addEventListener(type,e=>{
      if(e.target instanceof HTMLMediaElement)log(type,{time:e.target.currentTime,raw:volume.get.call(e.target),muted:e.target.muted});
    },true);
    p.snapshot=()=>({at:performance.now(),url:location.href,media:Array.from(document.querySelectorAll('audio,video'),m=>({
      time:m.currentTime,duration:m.duration,raw:volume.get.call(m),muted:m.muted,paused:m.paused,ready:m.readyState,
      lease:m.getAttribute('data-volume-balancer-lease')})),
      contexts:p.contexts.map(c=>({state:c.state,time:c.currentTime})),
      signals:p.points.filter(x=>x.connected).map(x=>{const a=new Float32Array(x.analyser.fftSize);x.analyser.getFloatTimeDomainData(a);
        return{rms:Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length),gate:x.source.gain?.value,state:x.source.context.state};})});
    log('installed-before-automatic');
  })()
