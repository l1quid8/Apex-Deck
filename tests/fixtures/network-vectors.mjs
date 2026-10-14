// Synthetic attack fixtures; these strings run only in the temporary gate app.
export function networkVectors({ bases, phase, dnsSuffix, webtransport, certificateHash, turn, turnUsername, turnPassword, stun6, turn6 }) {
  const settings = { bases, phase, dnsSuffix, webtransport, certificateHash, turn, turnUsername, turnPassword, stun6, turn6 };
  return `(() => {
    const s = ${JSON.stringify(settings)};
    const attempts = []; window.__networkAttempts = attempts; window.__networkObjects = [];
    const attempt = (name, action) => { try { const value = action(); attempts.push({name, invoked:true}); if (value?.catch) value.catch(e => attempts.push({name, error:e.name})); } catch(e) { attempts.push({name,error:e.name}); } };
    for (const [index, base] of s.bases.entries()) {
      const url = name => base+'/'+s.phase+'/'+index+'/'+name;
      attempt('fetch:'+index, () => fetch(url('fetch'),{mode:'no-cors'}));
      attempt('xhr:'+index, () => {const x=new XMLHttpRequest();x.open('GET',url('xhr'));x.send();});
      attempt('beacon:'+index, () => navigator.sendBeacon(url('beacon'),'synthetic'));
      attempt('image:'+index, () => {const x=new Image(); x.src=url('image.png');document.body.append(x);});
      attempt('import:'+index, () => import(url('module.js')));
      attempt('css:'+index, () => {const x=document.createElement('style');x.textContent='@import url('+url('import.css')+');@font-face{font-family:probe'+index+';src:url('+url('font.woff2')+')}#font'+index+'{font-family:probe'+index+';background-image:url('+url('background.png')+')}';document.head.append(x);const p=document.createElement('p');p.id='font'+index;p.textContent='font';document.body.append(p);});
      attempt('font:'+index, () => {const f=new FontFace('api'+index,'url('+url('font-api.woff2')+')');document.fonts.add(f);return f.load();});
      attempt('svg-image:'+index, () => {const x=document.createElementNS('http://www.w3.org/2000/svg','svg');x.innerHTML='<image href="'+url('image.svg')+'" width="10" height="10"/><use href="'+url('use.svg')+'#p"/>';document.body.append(x);});
      attempt('ws:'+index, () => {const x=new WebSocket(url('ws').replace(/^http/,'ws'));window.__networkObjects.push(x);});
      attempt('redirect:'+index, () => fetch(url('redirect/start'),{mode:'no-cors'}));
      attempt('external-worker:'+index, () => new Worker(url('worker.js')));
      attempt('blob-worker:'+index, () => {const x=new Worker(URL.createObjectURL(new Blob(['fetch('+JSON.stringify(url('inside-blob-worker'))+').catch(()=>{});'],{type:'text/javascript'})));window.__networkObjects.push(x);});
    }
    for (const rel of ['dns-prefetch','preconnect']) attempt(rel, () => {const l=document.createElement('link');l.rel=rel;l.crossOrigin='anonymous';l.href='https://'+rel+'-'+s.phase+'.'+s.dnsSuffix+':'+new URL(s.bases[1]||s.bases[0]).port;document.head.append(l);});
    for (const transport of ['udp','tcp']) attempt('turn:'+transport, () => {const pc=new RTCPeerConnection({iceTransportPolicy:'relay',iceServers:[{urls:'turn:'+s.turn+'?transport='+transport,username:s.turnUsername,credential:s.turnPassword}]});window.__networkObjects.push(pc);pc.createDataChannel('synthetic');return pc.createOffer().then(offer=>pc.setLocalDescription(offer));});
    attempt('stun', () => {const pc=new RTCPeerConnection({iceServers:[{urls:'stun:'+s.turn}]});window.__networkObjects.push(pc);pc.createDataChannel('synthetic');return pc.createOffer().then(offer=>pc.setLocalDescription(offer));});
    for(const [name,url] of [['stun6',s.stun6],['turn6-tcp',s.turn6]]) if(url) attempt(name,()=>{const pc=new RTCPeerConnection({iceServers:[{urls:url,username:s.turnUsername,credential:s.turnPassword}]});window.__networkObjects.push(pc);pc.createDataChannel('ipv6-synthetic');return pc.createOffer().then(offer=>pc.setLocalDescription(offer));});
    attempt('webtransport', () => {const t=new WebTransport(s.webtransport,{serverCertificateHashes:[{algorithm:'sha-256',value:new Uint8Array(s.certificateHash)}]});window.__networkObjects.push(t);return t.ready.then(()=>attempts.push({name:'webtransport',ready:true}));});
  })();`;
}

export function navigationVector(base, phase, kind) {
  const target = JSON.stringify(base+'/'+phase+'/'+kind);
  if (kind === 'location') return `setTimeout(()=>{location.href=${target}},30);`;
  if (kind === 'nested-remote') return `const f=document.createElement('iframe');f.src=${target};document.body.append(f);`;
  if (kind === 'nested-srcdoc') return `const f=document.createElement('iframe');f.srcdoc='<img src="'+${target}+'">';document.body.append(f);`;
  if (kind === 'form') return `const f=document.createElement('form');f.action=${target};f.method='POST';document.body.append(f);setTimeout(()=>f.submit(),30);`;
  if (kind === 'anchor') return `const a=document.createElement('a');a.href=${target};a.textContent='link';document.body.append(a);setTimeout(()=>a.click(),30);`;
  throw new Error('Unknown navigation fixture');
}

export function witnessedNavigationVector(base, phase, kind) {
  return `setTimeout(()=>{console.log(${JSON.stringify('NETWORK_VECTOR_INVOKED:'+phase)});${navigationVector(base,phase,kind)}},150);`;
}
