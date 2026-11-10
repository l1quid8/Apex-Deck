const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(60);
  const run = code => win.webContents.executeJavaScript(code);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const settle = async () => { await frame(); await sleep(300); await frame(); };
  const snapshot = () => run('fixture.snapshot()');
  const near = (actual, expected, note, tolerance = 1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${note}: got ${actual}, expected ${expected} ±${tolerance}`);
  const snapped = state => assert.ok(state.snaps.some(value => Math.abs(value - (state.axis === 'x' ? state.scrollLeft : state.scrollTop)) <= 1), 'native scroll settled on a line: ' + JSON.stringify(state));
  const inside = (state, id) => {
    const pane = state.panes[id];
    const region = { x: state.root.x + state.region.x, y: state.root.y + state.region.y, w: state.region.w, h: state.region.h };
    assert.ok(pane.display !== 'none' && pane.x >= region.x - 1 && pane.y >= region.y - 1 && pane.right <= region.x + region.w + 1 && pane.bottom <= region.y + region.h + 1,
      `${id} fully inside region: ` + JSON.stringify({ pane, region, scrollTop: state.scrollTop, scrollLeft: state.scrollLeft }));
  };
  const pointer = async (x, y) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await frame(); };
  const pointerOff = async () => { win.webContents.sendInputEvent({ type: 'mouseLeave', x: -10, y: -10 }); await frame(); };
  const wheel = async (x, y, deltaY, modifiers = []) => {
    await pointer(x, y);
    win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaY, deltaX: 0, modifiers, canScroll: true, hasPreciseScrollingDeltas: true });
    await frame();
  };
  const key = async keyCode => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await frame();
  };
  const focus = async () => {
    win.webContents.focus();
    await run('document.querySelector("[data-pane-map-region]").focus()');
    assert.equal(await run('document.activeElement===document.querySelector("[data-pane-map-region]")'), true, 'native region is focused');
  };
  const reset = async (options = {}) => {
    await pointerOff();
    await run('fixture.reset(' + JSON.stringify(options) + ')');
    await settle();
    await run('document.querySelector("[data-pane-map-region]").scrollTo(0,0)');
    await settle();
  };
  try {
    const errors = [];
    win.webContents.on('console-message', event => { if (/Failed to resolve import|does not provide an export|Uncaught/.test(event.message)) errors.push(event.message); });
    await win.loadURL(fixtureUrl);
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (await run('!!window.fixture && !!document.querySelector("[data-pane-map-region]")')) { ready = true; break; }
      await sleep(25);
    }
    assert.ok(ready, 'PaneMap fixture mounted: ' + errors.join('\n') + await run('document.body.innerText.slice(-2000)'));
    await settle();
    win.webContents.focus();

    const review = new URL(fixtureUrl).searchParams.get('review');
    if (review) {
      await reset();
      if (review === 'motion-lifetime') {
        const samples = await run(`new Promise(resolve=>{
          fixture.setOrder(['p5',...Array.from({length:14},(_,i)=>'p'+i).filter(id=>id!=='p5')]);
          const samples=[],start=performance.now();let held=false;
          const tick=time=>{
            if(!held){held=true;const end=performance.now()+60;while(performance.now()<end){}}
            const map=document.querySelector('[data-pane-map-region]');
            const gliding=[...map.querySelectorAll('.pane-map-slot')].some(slot=>slot.getAnimations().some(a=>a.playState==='running'));
            samples.push({gliding,moving:map.hasAttribute('data-moving')});
            if(time-start<850)requestAnimationFrame(tick);else resolve(samples);
          };requestAnimationFrame(tick);
        })`);
        assert.ok(samples.some(s=>s.gliding), 'reorder produces real slot transitions');
        assert.deepEqual(samples.filter(s=>s.gliding&&!s.moving), [], 'motion covers every delayed transition frame');
        const settled=samples.findIndex(s=>!s.moving);
        assert.ok(settled>=0, 'motion eventually settles');
        assert.ok(samples.slice(settled).every(s=>!s.moving), 'motion never restarts after settling');
        await run(`document.querySelector('.pane-map-slot').dispatchEvent(new TransitionEvent('transitionend',{bubbles:true,propertyName:'top'}))`);
        assert.equal(await run(`document.querySelector('[data-pane-map-region]').hasAttribute('data-moving')`), false, 'a late transitionend cannot restart settled motion');
      } else if (review === 'popups') {
        const probe = async id => {
          const boxes = await run(`(()=>{const parent=document.querySelector('[data-id="${id}"]');
            const small=document.createElement('div'),full=document.createElement('div');
            small.style.cssText='position:fixed;left:342px;top:329px;width:40px;height:30px';
            full.style.cssText='position:fixed;inset:0'; parent.append(small,full);
            const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
            const result={small:rect(small),full:rect(full)};small.remove();full.remove();return result})()`);
          near(boxes.small.x,342,id+' fixed popup x'); near(boxes.small.y,329,id+' fixed popup y');
          near(boxes.full.x,0,id+' fullscreen x'); near(boxes.full.y,0,id+' fullscreen y');
          near(boxes.full.w,1200,id+' fullscreen width'); near(boxes.full.h,800,id+' fullscreen height');
        };
        await probe('p5');
        await run('fixture.step(1)'); await frame(); await probe('p5'); await settle();
        await reset({arrangement:{mode:'left'}}); await probe('p0'); await probe('p5');
        await run('document.querySelector("[data-pane-map-region]").scrollTop=500'); await frame(); await probe('p0'); await probe('p5');
      } else if (review === 'focus-glide') {
        const order = ['p5', ...Array.from({length:14}, (_,i)=>'p'+i).filter(id=>id!=='p5')];
        const sample = async (options, changes, start, end) => {
          await reset(options);
          const before = (await snapshot()).panes.p5;
          near(before.x, start.x, 'glide starts at old x'); near(before.y, start.y, 'glide starts at old y');
          const frames = await run(`new Promise(resolve=>{
            ${changes};
            const samples=[], start=performance.now();
            const tick=time=>{const r=document.querySelector('[data-pane-id=p5]').getBoundingClientRect();samples.push({x:r.x,y:r.y,t:time});
              if(time-start<360)requestAnimationFrame(tick);else resolve(samples)};
            requestAnimationFrame(tick);
          })`);
          assert.ok(Math.hypot(frames[0].x-start.x,frames[0].y-start.y)<60,'first frame retains old drawn position: '+JSON.stringify(frames[0]));
          assert.ok(frames.some(p=>Math.hypot(p.x-start.x,p.y-start.y)>5&&Math.hypot(p.x-end.x,p.y-end.y)>5),'glide draws intermediate positions');
          // Chromium can skip frames under suite load. Bound speed by elapsed
          // time and ease's peak slope, rather than treating a skipped frame as a jump.
          const distance=Math.hypot(end.x-start.x,end.y-start.y);
          for(let i=1;i<frames.length;i++) assert.ok(Math.hypot(frames[i].x-frames[i-1].x,frames[i].y-frames[i-1].y)<=distance*Math.min(1,3*(frames[i].t-frames[i-1].t)/220)+5,'no position discontinuity: '+JSON.stringify(frames.slice(i-1,i+1)));
          const after=(await snapshot()).panes.p5; near(after.x,end.x,'glide final x');near(after.y,end.y,'glide final y');
        };
        await sample({active:['p5']}, `fixture.setOrder(${JSON.stringify(order)});fixture.setMode('right')`, {x:302,y:269.328125}, {x:508.640625,y:0});
        await sample({active:['p5']}, `fixture.setOrder(${JSON.stringify(order)});fixture.setMode('left')`, {x:302,y:269.328125}, {x:0,y:0});
        await sample({active:['p5'],arrangement:{mode:'right',order}}, `fixture.setMode('grid')`, {x:508.640625,y:0}, {x:0,y:0});
        // A position animation must never create a containing block for a fixed popup.
        await reset({active:['p5']});
        await run(`fixture.setOrder(${JSON.stringify(order)});fixture.setMode('right')`); await frame();
        const popup=await run(`(()=>{const el=document.createElement('div');el.style.cssText='position:fixed;left:342px;top:329px;width:40px;height:30px';document.querySelector('[data-pane-id=p5]').append(el);const r=el.getBoundingClientRect();const result={x:r.x,y:r.y};el.remove();return result})()`);
        near(popup.x,342,'mid-glide fixed popup x'); near(popup.y,329,'mid-glide fixed popup y');
        await settle();
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        await reset({active:['p5']});
        await run(`fixture.setOrder(${JSON.stringify(order)});fixture.setMode('right')`); await frame();
        const reduced=(await snapshot()).panes.p5;near(reduced.x,508.640625,'reduced motion lands immediately');near(reduced.y,0,'reduced motion y');
        win.webContents.debugger.detach();
      } else if (review === 'focus-interruptions') {
        const order = ['p5', ...Array.from({length:14}, (_,i)=>'p'+i).filter(id=>id!=='p5')];
        await reset({active:['p5']});
        await run(`fixture.setOrder(${JSON.stringify(order)});fixture.setMode('right')`);await frame();await sleep(60);
        const xBefore=(await snapshot()).panes.p5.x;
        assert.ok(xBefore>302&&xBefore<509,'interrupt an in-progress incoming Focus glide');
        const positions=await run(`new Promise(resolve=>{fixture.setMode('left');const xs=[],start=performance.now();const tick=t=>{const slot=document.querySelector('[data-pane-id=p5]');if(slot.style.marginLeft==='0px')xs.push(slot.getBoundingClientRect().x);if(t-start<360)requestAnimationFrame(tick);else resolve(xs)};requestAnimationFrame(tick)})`);
        assert.ok(positions.some(x=>x>5),'reversal draws intermediate positions');
        for(let i=1;i<positions.length;i++) assert.ok(positions[i]<=positions[i-1]+1,'after the left-side commit the glide never continues toward the stale right-hand destination: '+JSON.stringify(positions));
        near(positions.at(-1),0,'interrupted glide ends at new Focus side');

        await reset({arrangement:{mode:'left'}});await pointer(60,14);
        win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:60,y:14});await frame();
        win.webContents.sendInputEvent({type:'mouseMove',x:1000,y:100,modifiers:['leftButtonDown']});await frame();
        win.webContents.sendInputEvent({type:'mouseMove',x:1050,y:150,modifiers:['leftButtonDown']});await frame();
        const lifted=(await snapshot()).panes.p0;
        near(lifted.x,990,'lifted former Focus pane follows pointer x immediately');near(lifted.y,136,'lifted former Focus pane follows pointer y immediately');
        await key('Escape');win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:1050,y:150});await settle();
      } else if (review === 'divider-live') {
        await reset({arrangement:{mode:'left'}});
        const d=await run('(()=>{const r=document.querySelector(".pane-map-divider").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:400}})()');
        await pointer(d.x,d.y);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...d});await frame();
        for(let i=1;i<=6;i++){
          win.webContents.sendInputEvent({type:'mouseMove',x:d.x+i*20,y:d.y,modifiers:['leftButtonDown']});await frame();
          const state=await snapshot();near(state.panes.p0.w,691.359375+i*20,'Focus width follows divider in same frame');
          assert.equal(await run('getComputedStyle(document.querySelector("[data-pane-id=p1]")).transitionDuration'),'0s','side pane follows divider too');
        }
        win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:d.x+120,y:d.y});await settle();
        await pointer(25,14);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:25,y:14});await frame();
        win.webContents.sendInputEvent({type:'mouseMove',x:70,y:40,modifiers:['leftButtonDown']});await frame();
        assert.ok(parseFloat(await run('getComputedStyle(document.querySelector("[data-pane-id=p1]")).transitionDuration'))>0,'title drags keep the glide');
        await key('Escape');win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:70,y:40});await settle();
      } else if (review === 'keys') {
        await run('document.querySelector("[data-id=p3] button").focus()'); await key('-'); await settle();
        assert.equal((await snapshot()).levelIdx,1,'a pane button must not activate map zoom');
        await focus(); await key('-'); await settle(); assert.equal((await snapshot()).levelIdx,0,'map focus activates zoom');
      } else if (review === 'restore') {
        await reset({active:['p5']});
        await run('document.querySelector("[data-pane-map-region]").scrollTop=fixture.snapshot().snaps.at(-1)'); await settle();
        const before=(await snapshot()).scrollTop;
        await run('fixture.setMaximized("p5")'); await settle();
        await run('fixture.setMaximized(null)'); await settle(); near((await snapshot()).scrollTop,before,'restoring fullscreen preserves scroll');
      } else if (review === 'drag-out') {
        await pointer(25,14); win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:25,y:14}); await frame();
        for(let i=1;i<=6;i++){win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(25+1205*i/6),y:Math.round(14+136*i/6),modifiers:['leftButtonDown']});await frame();}
        win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:1230,y:150}); await settle();
        const state=await snapshot(); assert.equal(state.popouts.length,1,'one popout');
        assert.deepEqual(state.arrangement.order.slice(0,4),['p0','p1','p2','p3'],'drag-out restores original order');
        assert.equal(state.popouts[0][3].split(",").slice(0,4).join(","),"p0,p1,p2,p3","popout snapshot sees restored order");
      } else if (review === 'renders') {
        const before=(await snapshot()).renders;
        for(let i=0;i<12;i++){ await wheel(298,400,-50); await sleep(16); } await settle();
        const after=(await snapshot()).renders;
        for(const id of ['other-section','popped-out']) assert.equal(after[id]-before[id],0,id+' never visible must not re-render');
        for(let i=0;i<14;i++) assert.ok(after['p'+i]-before['p'+i]<=2,'pane only renders on visibility transitions: p'+i+' '+(after['p'+i]-before['p'+i]));
        await reset(); await pointer(25,14);
        win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:25,y:14}); await frame();
        const start=(await snapshot()).renders;
        for(let i=0;i<6;i++){ win.webContents.sendInputEvent({type:'mouseMove',x:40+i*5,y:40,modifiers:['leftButtonDown']});await frame(); }
        assert.deepEqual((await snapshot()).renders,start,'same-cell drag moves render no panes');
        await key('Escape'); win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:65,y:40}); await settle();
      } else if (review === 'reduced-pinned') {
        await reset({arrangement:{mode:'left'}});
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]}); await frame();
        assert.equal(await run('getComputedStyle(document.querySelector(".pane-map-slot.pinned")).transitionDuration'),'0s','reduced motion disables sticky Focus glide');
        win.webContents.debugger.detach();
      } else if (review === 'paint') {
        await reset({arrangement:{mode:'left'}});
        await run(`document.head.insertAdjacentHTML('beforeend','<style>[data-id=p0]{background:rgb(255,0,0)!important;border:0!important;border-radius:0!important}[data-id=p0]>*{visibility:hidden}.pane-map-divider{background:rgb(0,255,0)!important}.pane-map-divider::after{display:none}</style>')`); await settle();
        const state=await snapshot(); const frames=[];
        const sample=(image,x,test)=>{const {width,height}=image.getSize(),data=image.toBitmap();let first=-1,last=-1;for(let y=0;y<height;y++){const i=(y*width+x)*4;if(test(data[i+2],data[i+1],data[i])){if(first<0)first=y;last=y;}}return {first,last}};
        const x=Math.floor(state.panes.p0.w/2), dx=Math.floor(state.region.x-4);
        const capture=(_event,_dirty,image)=> frames.push({focus:sample(image,x,(r,g,b)=>r>200&&g<60&&b<60),divider:sample(image,dx,(r,g,b)=>g>200&&r<60&&b<60)});
        win.webContents.on('paint',capture); win.webContents.invalidate(); await sleep(100);
        const sx=Math.floor(state.region.x+60); await pointer(sx,400);
        let maximumScroll=0;
        for(const delta of [-45,45]){for(let i=0;i<24;i++){win.webContents.sendInputEvent({type:'mouseWheel',x:sx,y:400,deltaX:0,deltaY:delta,canScroll:true,hasPreciseScrollingDeltas:true});await sleep(16);}await sleep(300);maximumScroll=Math.max(maximumScroll,(await snapshot()).scrollTop);}
        assert.ok(maximumScroll>500,'paint capture scrolls more than one side pane');
        win.webContents.invalidate(); await sleep(100); win.webContents.removeListener('paint',capture);
        assert.ok(frames.length>5,'actual compositor frames captured');
        for(const f of frames){near(f.focus.first,0,'Focus top in drawn frame');near(f.focus.last,799,'Focus bottom in drawn frame');near(f.divider.first,0,'divider top in drawn frame');near(f.divider.last,799,'divider bottom in drawn frame');}
        console.log('Focus compositor frames',frames.length);
      }
      console.log('PaneMap review regression passed:',review); win.destroy(); app.exit(0); return;
    }

    if (new URL(fixtureUrl).searchParams.has('viewport-only')) {
      await reset();
      let state = await snapshot();
      assert.ok(state.onScreenPanes.includes('p0'), 'the first pane is reported on screen');
      assert.ok(!state.onScreenPanes.includes('p13'), 'a pane below the fold is not reported on screen');
      await run('document.querySelector("[data-pane-map-region]").scrollTop=fixture.snapshot().snaps.at(-1)'); await settle();
      state = await snapshot();
      assert.ok(!state.onScreenPanes.includes('p0'), 'scrolling retires the first pane from the visible set');
      assert.ok(state.onScreenPanes.includes('p13'), 'scrolling reports the newly visible pane');
      await run('fixture.setMaximized("p2")'); await settle();
      assert.deepEqual((await snapshot()).onScreenPanes, ['p2'], 'only the maximized pane is reported on screen');
      await run('fixture.setMaximized(null)'); await settle();
      await run('fixture.setOrder(["other-section","popped-out"])'); await settle();
      assert.deepEqual((await snapshot()).onScreenPanes, ['other-section','popped-out'], 'the visible set follows a new section inventory');
      console.log('PaneMap reports viewport visibility across scrolling, maximize and section changes');
      win.destroy(); app.exit(0); return;
    }

    if (new URL(fixtureUrl).searchParams.has('interruptions-only')) {
      await reset(); await pointer(25,14);
      win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, x:25, y:14 }); await frame();
      win.webContents.sendInputEvent({ type:'mouseMove', x:500, y:130, modifiers:['leftButtonDown'] }); await settle();
      await run('fixture.setOrder(["other-section","popped-out"])'); await settle();
      win.webContents.sendInputEvent({ type:'mouseMove', x:700, y:140, modifiers:['leftButtonDown'] }); await settle();
      await key('Escape');
      win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, x:700, y:140 }); await settle();
      assert.deepEqual((await snapshot()).arrangement.order, ['other-section','popped-out'], 'a section change retires the drag without restoring its former inventory');
      assert.equal(await run('!!document.querySelector(".pane-map-slot.dragging")'), false, 'the obsolete drag is no longer lifted');

      await reset({ arrangement:{mode:'left'} });
      const divider = await run('(()=>{const r=document.querySelector(".pane-map-divider").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:400}})()');
      await pointer(divider.x,divider.y);
      win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, ...divider }); await settle();
      assert.equal(await run('document.querySelector(".pane-map").classList.contains("adjusting")'), true, 'divider drag starts');
      win.setContentSize(500,650); await settle();
      win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, x:400, y:400 }); await settle();
      assert.equal(await run('document.querySelector(".pane-map").classList.contains("adjusting")'), false, 'removing the divider during resize restores pane input');
      win.setContentSize(1200,800); await settle();
      assert.equal(await run('document.querySelector(".pane-map").classList.contains("adjusting")'), false, 'pane input stays live after the divider returns');
      console.log('PaneMap retires interrupted section drags and divider resizing');
      win.destroy(); app.exit(0); return;
    }

    if (new URL(fixtureUrl).searchParams.has('navigation-only')) {
      await reset(); await focus(); await pointerOff(); await key('End'); await settle();
      const navigation = await snapshot();
      console.log('Navigation input', JSON.stringify(navigation.keyEvents), 'active', await run('document.activeElement.outerHTML.slice(0,200)'));
      near(navigation.scrollTop, navigation.snaps.at(-1), 'End goes to last line');
      win.destroy(); app.exit(0); return;
    }

    if (new URL(fixtureUrl).searchParams.has('divider-only')) {
      await reset({ arrangement: { mode: 'left' } });
      await run('document.querySelector(".pane-map-divider").focus()');
      let width = (await snapshot()).panes.p0.w;
      for (let i = 0; i < 40; i++) {
        await key('Right');
        const next = await run('document.querySelector("[data-pane-id=p0]").getBoundingClientRect().width');
        assert.ok(next >= width - 1, 'divider must not reset before reaching max width; step ' + i + ': ' + next + ' < ' + width);
        width = next;
      }
      await settle();
      const divider = await snapshot();
      const maxShare = (divider.root.w-8-260)/(divider.root.w-8);
      assert.ok(divider.arrangement.focusShare <= maxShare + 0.001, 'divider state stays within its geometric upper bound');
      near(divider.panes.p0.w, divider.root.w-8-260, 'divider reaches its rightmost valid width');
      for (let i = 0; i < 40; i++) await key('Left');
      await settle(); near((await snapshot()).panes.p0.w, 320, 'divider reaches its minimum width');
      const location = () => run('(()=>{const r=document.querySelector(".pane-map-divider").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
      let at = await location(); await pointer(at.x, at.y);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at }); await frame();
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 504, y: at.y, modifiers: ['leftButtonDown'] }); await settle();
      near((await snapshot()).panes.p0.w, 500, 'native divider drag changes the focus width live');
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 504, y: at.y }); await settle();
      at = await location(); await pointer(at.x, at.y);
      for (const clickCount of [1,2]) {
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount, ...at });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount, ...at }); await frame();
      }
      await settle(); near((await snapshot()).arrangement.focusShare, 0.58, 'native divider double click restores the default share', 0.001);
      console.log('PaneMap repeated native divider keys clamp, pointer drag updates live, and double click resets');
      win.destroy(); app.exit(0); return;
    }

    if (new URL(fixtureUrl).searchParams.has('drag-only')) {
      const order = Array.from({ length: 14 }, (_, i) => 'p'+i);
      const point = async (id, button = false) => run('(()=>{const r=document.querySelector('+JSON.stringify('[data-pane-id="'+id+'"] .pane-head'+(button?' button':''))+').getBoundingClientRect();return {x:Math.round(r.x+( '+button+'?r.width/2:25)),y:Math.round(r.y+r.height/2)}})()');
      const start = async (id, button = false) => {
        const from = await point(id, button);
        await pointer(from.x, from.y);
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...from });
        await frame(); return from;
      };
      const move = async (from, to) => {
        for (let n = 1; n <= 6; n++) {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x+(to.x-from.x)*n/6), y: Math.round(from.y+(to.y-from.y)*n/6), modifiers: ['leftButtonDown'] });
          await frame();
        }
      };
      const release = async to => {
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...to });
        await settle();
      };
      await reset();
      let state = await snapshot();
      let from = await start('p0');
      let target = { x: Math.round(state.panes.p3.x + state.panes.p3.w/2), y: Math.round(state.panes.p3.y + state.panes.p3.h/2) };
      await move(from, target);
      const lifted = await snapshot();
      assert.ok(lifted.panes.p0.x > state.panes.p0.x + 100, 'dragged pane follows the native pointer before release');
      assert.equal(await run('getComputedStyle(document.querySelector("[data-pane-map-region]")).scrollSnapType'), 'none', 'snap is disabled while dragging');
      await release(target);
      assert.deepEqual((await snapshot()).arrangement.order.slice(0,4), ['p1','p2','p3','p0'], 'title drag trades the dragged slot into p3 position');
      await reset(); state = await snapshot(); from = await start('p0');
      target = { x: Math.round(state.panes.p3.x + state.panes.p3.w/2), y: Math.round(state.panes.p3.y + state.panes.p3.h/2) };
      await move(from, target); await key('Escape'); await release(target);
      assert.deepEqual((await snapshot()).arrangement.order, order, 'Escape cancels the drag');

      await reset(); state = await snapshot(); from = await start('p0');
      target = { x: Math.round(state.panes.p3.x + state.panes.p3.w/2), y: Math.round(state.panes.p3.y + state.panes.p3.h/2) };
      await move(from, target);
      const primary = (await snapshot()).panes.p0;
      await run('(()=>{const head=document.querySelector("[data-pane-id=p1] .pane-head"),r=head.getBoundingClientRect();head.dispatchEvent(new PointerEvent("pointerdown",{pointerId:999999,pointerType:"touch",isPrimary:false,button:0,clientX:r.x+20,clientY:r.y+14,bubbles:true}))})()'); await frame();
      await run('window.dispatchEvent(new PointerEvent("pointermove",{pointerId:999999,clientX:20,clientY:20,bubbles:true}))'); await frame();
      near((await snapshot()).panes.p0.x, primary.x, 'an unrelated pointer cannot move the active drag');
      await run('window.dispatchEvent(new PointerEvent("pointerup",{pointerId:999999,clientX:20,clientY:20,bubbles:true}))'); await frame();
      assert.equal(await run('!!document.querySelector("[data-pane-id=p0].dragging")'), true, 'an unrelated pointer cannot finish the active drag');
      await run('window.dispatchEvent(new PointerEvent("pointercancel",{pointerId:999999,bubbles:true}))'); await frame();
      assert.equal(await run('!!document.querySelector("[data-pane-id=p0].dragging")'), true, 'an unrelated pointer cannot cancel the active drag');
      await release(target);
      assert.equal(await run('!!document.querySelector("[data-pane-id=p0].dragging")'), false, 'the primary pointer finishes its drag');

      await reset(); from = await start('p0', true); await release(from);
      state = await snapshot(); assert.deepEqual(state.clicks, ['p0'], 'native title button click reaches its action'); assert.deepEqual(state.arrangement.order, order, 'button click leaves pane order alone');
      from = await start('p0', true); await move(from, target); await release(target);
      assert.deepEqual((await snapshot()).arrangement.order, order, 'dragging a title button cannot start pane dragging');

      await reset(); await run('document.querySelector("[data-pane-map-region]").scrollTop=fixture.snapshot().snaps.at(-1)'); await settle();
      state = await snapshot(); from = await start('p4');
      target = { x: Math.round(state.panes.p7.x + state.panes.p7.w/2), y: Math.round(state.panes.p7.y + state.panes.p7.h/2) };
      await move(from, target); await release(target);
      assert.deepEqual((await snapshot()).arrangement.order.slice(4,8), ['p5','p6','p7','p4'], 'drag hit testing includes the current native scroll');

      await reset(); from = await start('p0'); target = { x: 100, y: 790 };
      await move(from, target); await sleep(800);
      state = await snapshot(); assert.ok(state.scrollTop > 0, 'a held drag near the edge auto-scrolls');
      assert.ok(state.scrollTop <= state.snaps.at(-1) + 1, 'drag edge pan stops at the last line: ' + state.scrollTop + ' > ' + state.snaps.at(-1));
      await key('Escape'); await release(target);

      await reset(); from = await start('p0'); target = { x: 1230, y: 150 };
      await move(from, target); await release(target);
      state = await snapshot(); assert.equal(state.popouts.length, 1, 'release outside the window requests one pop-out');
      assert.equal(state.popouts[0][0], 'p0'); assert.ok(state.popouts[0].slice(1,3).every(Number.isFinite), 'pop-out receives screen coordinates');
      console.log('PaneMap native title drag, Escape cancel, button exclusion, scrolled hit testing, bounded edge pan and outside release passed');
      win.destroy(); app.exit(0); return;
    }

    let state = await snapshot();
    near(state.root.w, 1200, 'fixture width'); near(state.root.h, 800, 'fixture height');
    near(state.panes.p0.w, 294, 'default pane width'); near(state.panes.p0.h, 261.33, 'default pane height');
    await wheel(100, 100, 100, ['control']); // Electron wheel deltas have the opposite sign to DOM WheelEvent.
    await settle(); state = await snapshot(); near(state.panes.p0.w, 394.67, 'one native Ctrl wheel changes one level');
    const beforeSmall = state.levelIdx;
    for (let i = 0; i < 8; i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaY: 4, deltaX: 0, modifiers: ['control'], canScroll: true, hasPreciseScrollingDeltas: true });
      await sleep(20);
    }
    await settle(); state = await snapshot(); assert.equal(state.levelIdx, beforeSmall + 1, 'eight small wheel deltas make exactly one more level');
    assert.equal(win.webContents.getZoomFactor(), 1, 'Ctrl wheel never zooms the Chromium page');

    await reset(); await wheel(298, 100, -500); await sleep(450); state = await snapshot(); assert.ok(state.scrollTop > 0, 'plain native wheel scrolls down'); snapped(state);
    await reset({ arrangement: { mode: 'vertical' } }); await wheel(298, 100, -500); await sleep(450);
    state = await snapshot(); assert.ok(state.scrollLeft > 0, 'vertical gap wheel moves sideways'); near(state.scrollTop, 0, 'vertical has no vertical scrolling', 0);

    await reset({ active: ['p13'] }); await run('fixture.reveal("p13")'); await settle();
    win.setContentSize(900, 650); await settle(); state = await snapshot(); inside(state, 'p13'); snapped(state);
    win.setContentSize(1200, 800); await settle();
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await frame(); state = await snapshot(); assert.equal(state.panes.p0.transition, '0s', 'reduced motion removes pane glide');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();

    await reset(); state = await snapshot(); assert.ok(state.panes.p13.y >= state.root.bottom, 'last pane starts below the fold');
    await run('fixture.reveal("p13")'); await settle(); state = await snapshot(); inside(state, 'p13'); snapped(state);
    await reset({ maximized: 'p2' }); await run('fixture.reveal("p13")'); await settle();
    state = await snapshot(); assert.equal(state.restores, 1, 'reveal asks parent to restore exactly once'); assert.equal(state.maximized, 'p2', 'reveal waits for parent restore');
    assert.equal(state.panes.p13.display, 'none', 'pending reveal keeps panes behind maximized pane hidden');
    await run('fixture.setMaximized(null)'); await settle();
    state = await snapshot(); inside(state, 'p13'); snapped(state);

    await reset({ arrangement: { mode: 'left' } }); await focus(); await pointerOff();
    await key('='); await settle(); state = await snapshot();
    assert.equal(state.level.cols, 1); assert.equal(state.level.rows, 2); near(state.scrollTop, 0, 'keyboard keeps region centre pane on its screen line'); inside(state, 'p2');
    await key('-'); await settle(); state = await snapshot(); assert.equal(state.level.rows, 3); near(state.scrollTop, 0, 'zoom out with Focus active');

    await reset({ active: ['p0', 'p13'] }); await focus(); await pointer(975, 50); await key('='); await settle();
    state = await snapshot(); assert.equal(state.level.cols, 3); assert.equal(state.level.rows, 3); near(state.scrollTop, 269.33, 'key follows resting pointer over p3');
    await reset({ active: ['p0', 'p13'] }); await focus(); await pointer(630, 30);
    for (let i = 0; i < 3; i++) { await key('='); await settle(); }
    state = await snapshot(); assert.equal(state.level.cols, 2); assert.equal(state.level.rows, 2); near(state.scrollTop, 404, 'still pointer retains p2 through three levels'); inside(state, 'p2');

    await reset({ arrangement: { mode: 'left' } }); const focusStart = await snapshot();
    await wheel(100, 100, 100, ['control']); await settle(); state = await snapshot();
    assert.equal(state.levelIdx, focusStart.levelIdx, 'no zoom over Focus pane'); near(state.scrollTop, focusStart.scrollTop, 'Focus wheel leaves scrolling alone');
    assert.ok(state.wheelEvents.at(-1)?.prevented, 'Focus wheel bubbles as defaultPrevented');

    await reset({ active: ['p6'] }); await run('fixture.step(1)'); await settle();
    await run('document.querySelector("[data-pane-map-region]").scrollTop=fixture.snapshot().snaps.at(-1)'); await settle();
    await wheel(100, 100, 100, ['control']); await settle(); state = await snapshot(); near(state.scrollTop, 808, 'zoom keeps active p6 on the top line'); inside(state, 'p6');

    await reset(); await run('document.querySelector("[data-pane-map-region]").scrollTop=fixture.snapshot().snaps.at(-1)'); await settle();
    await run('fixture.addPane("new-pane")'); await settle(); state = await snapshot(); assert.equal(state.arrangement.order[0], 'new-pane'); assert.deepEqual(state.active, ['new-pane']); near(state.scrollTop, 0, 'new pane is revealed first'); inside(state, 'new-pane');

    // All 16 probe components remain the same instances, including hidden sections and pop-outs.
    await reset();
    const expectedDrafts = {};
    await run('fixture.setOrder([...Array.from({length:14},(_,i)=>"p"+i),"other-section","popped-out"])'); await settle();
    for (const id of Object.keys((await snapshot()).panes)) {
      expectedDrafts[id] = 'unsent draft ' + id;
      await run('fixture.reveal(' + JSON.stringify(id) + ')'); await settle();
      await run('document.querySelector(' + JSON.stringify('[data-id="' + id + '"] textarea') + ').focus()');
      win.webContents.insertText(expectedDrafts[id]); await frame();
    }
    for (const mode of ['horizontal', 'vertical', 'grid', 'left', 'right']) { await run('fixture.setMode(' + JSON.stringify(mode) + ')'); await settle(); }
    await run('fixture.setOrder(["p5",...fixture.snapshot().arrangement.order.filter(id=>id!=="p5")])'); await settle();
    await run('fixture.setMaximized("p7")'); await settle(); await run('fixture.setMaximized(null)'); await settle();
    await run('fixture.setOrder(["other-section","popped-out",...Array.from({length:12},(_,i)=>"p"+i)])'); await settle();
    await run('fixture.setOrder(Array.from({length:14},(_,i)=>"p"+i))'); await settle();
    state = await snapshot();
    for (const id of Object.keys(expectedDrafts)) {
      assert.equal(state.mounts[id], 1, id + ' mounted once'); assert.equal(state.unmounts[id] || 0, 0, id + ' never unmounted');
      assert.equal(state.drafts[id], expectedDrafts[id], id + ' keeps uncontrolled draft'); assert.ok(state.panes[id].parent, id + ' remains a direct child of one native scroller');
    }
    await reset(); await focus(); await pointerOff();
    await key('End'); await settle(); state = await snapshot(); near(state.scrollTop, state.snaps.at(-1), 'End goes to last line');
    await key('Home'); await settle(); state = await snapshot(); near(state.scrollTop, 0, 'Home goes to first line');
    await key('Down'); await settle(); state = await snapshot(); near(state.scrollTop, state.snaps[1], 'Down moves one line');
    await key('PageDown'); await settle(); state = await snapshot(); near(state.scrollTop, state.snaps.at(-1), 'PageDown moves one screen and clamps');

    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      for (const [width, height] of [[1512,945],[1100,650]]) {
        win.setContentSize(width, height);
        for (const mode of ['horizontal','vertical','grid','left','right']) {
          await reset({ arrangement: { mode } });
          fs.writeFileSync(path.join(screenshotDir, mode+'-'+width+'x'+height+'.png'), (await win.webContents.capturePage()).toPNG());
        }
      }
    }
    assert.deepEqual(errors, [], 'renderer has no uncaught module errors');
    console.log('PaneMap native input, scroll snaps, anchor retention, reveal, reduced motion, stable parents and draft preservation passed');
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack);
    try { console.error('Final PaneMap state:', JSON.stringify(await snapshot())); } catch {}
    win.destroy(); app.exit(1);
  }
});
