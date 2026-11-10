import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

for (const [width,height] of [[1512,945],[1100,650]]) test(`dock refits preserve deep reading and first-send level at ${width}`, {timeout:120000}, async () => {
  await withAppearanceApp('dock-refit', String.raw`
    const ids = Array.from({length:14},(_,i)=>'refit-'+i);
    const session = {version:1,workspaces:[{id:'w',name:'Sample',path:''}],panes:ids.map((id,i)=>({id,workspaceId:'w',kind:'chat',title:'Thread '+i,sample:true})),profiles:[],profileRevision:0,activeWorkspace:'w',focusedPane:ids[0],section:'threads',arrangements:{':threads':{mode:'horizontal',order:ids,zoom:1,focusShare:.58}},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
    await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
    await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');
    await load();await until('document.querySelectorAll(".pane-map-slot").length===14 && !!document.querySelector(".composer[data-room-ready] textarea:not(:disabled)")');await sleep(400);
    const shape=()=>run('(()=>{const m=document.querySelector(".pane-map");return {level:m.dataset.level,lefts:[...m.querySelectorAll(".pane-map-slot")].map(s=>s.style.left)}})()');
    const type=async text=>{await run('document.querySelector(".composer textarea").focus()');await win.webContents.insertText(text);await frame();await sleep(70);};
    const clear=async()=>{await run('(()=>{const t=document.querySelector(".composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(t,"");t.dispatchEvent(new Event("input",{bubbles:true}))})()');await frame();await sleep(150);};
    const settledMap=()=>until('(()=>{const m=document.querySelector(".pane-map");return !m.hasAttribute("data-moving")&&!m.hasAttribute("data-focus-moving")&&[...m.querySelectorAll(".pane-map-slot")].every(s=>s.getAnimations().every(a=>a.playState!=="running"))})()','pane map motion to finish');
    const beforeSend=await shape();await type('first');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await until('document.querySelector(".composer textarea").value===""');await sleep(300);
    assert.deepEqual(await shape(),beforeSend,'first Send keeps level and horizontal positions');
    await run('window.refitMarks=[];new MutationObserver(rs=>{for(const r of rs)if(r.target.hasAttribute("data-moving"))window.refitMarks.push(performance.now())}).observe(document.querySelector(".pane-map"),{attributes:true,attributeFilter:["data-moving"]})');
    const first=()=>run('(()=>{const m=document.querySelector(".pane-map"),mr=m.getBoundingClientRect();return [...m.querySelectorAll(".pane-map-slot:not([data-pinned])")].map(s=>({id:s.dataset.paneId,r:s.getBoundingClientRect()})).filter(o=>o.r.bottom>mr.top+1&&o.r.top<mr.bottom-1&&o.r.right>mr.left+1&&o.r.left<mr.right-1).sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left)[0]?.id})()');
    for(const mode of ['Horizontal','Focus left']) {
      await run('document.querySelector(".layout-picker-trigger").click()');await run('[...document.querySelectorAll("[role=menuitemradio]")].find(b=>b.querySelector("strong")?.textContent==='+JSON.stringify(mode)+').click()');await settledMap();
      await run('new Promise(resolve=>{const m=document.querySelector(".pane-map"),slots=[...m.querySelectorAll(".pane-map-slot:not([data-pinned])")],tops=[...new Set(slots.map(s=>parseFloat(s.style.top)))].sort((a,b)=>a-b),before=m.scrollTop;m.addEventListener("scrollend",()=>resolve(),{once:true});m.scrollTop=tops['+(mode==='Horizontal'?8:7)+'];if(m.scrollTop===before)resolve()})');await settledMap();
      if(mode==='Horizontal') {
        await run('(()=>{const m=document.querySelector(".pane-map"),mr=m.getBoundingClientRect(),on=[...m.querySelectorAll(".pane-map-slot")].filter(s=>{const r=s.getBoundingClientRect();return r.top>=mr.top-1&&r.bottom<=mr.bottom+1}).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);on[1].querySelector(".pane-head").click()})()');await sleep(200);
      } else {await run('document.querySelector("[data-pinned] .pane-head").click()');await sleep(200);}
      // Header focus can still be gliding after the click. Its settled snap is
      // the reading line whose preservation the edits below exercise.
      await settledMap();
      const reading=await first();await run('window.refitMarks=[]');
      for(let n=1;n<=9;n++){await type(n===1?'line':'\nline');assert.equal(await first(),reading,mode+' typing '+n);}
      await shot('refit-'+mode.replace(' ','-')+'-typed-${width}');
      await clear();assert.equal(await first(),reading,mode+' clearing');
      await type('1\n2\n3\n4\n5\n6\n7\n8\n9');assert.equal(await first(),reading,mode+' paste');
      await clear();assert.equal(await first(),reading,mode+' clearing paste');
      await shot('refit-'+mode.replace(' ','-')+'-clear-${width}');
      assert.deepEqual(await run('window.refitMarks'),[],mode+' refits never freeze previews');
    }
  `, {width,height});
});
