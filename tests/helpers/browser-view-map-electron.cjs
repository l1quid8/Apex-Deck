const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:false, width:1200, height:800, useContentSize:true, webPreferences:{ offscreen:true, backgroundThrottling:false } });
  const run = code => win.webContents.executeJavaScript(code);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const snapshot = () => run('fixture.snapshot()');
  const until = async (condition, note, duration = 500) => {
    const end = Date.now() + duration;
    while (Date.now() < end) {
      if (await run(condition)) return;
      await sleep(16);
    }
    assert.fail(note + ': ' + JSON.stringify(await snapshot()));
  };
  const nativeBounds = state => state.calls.filter(call => call.kind === 'show' || call.kind === 'bounds').at(-1)?.bounds;
  const expected = { x:180, y:160, width:300, height:200 };
  try {
    await win.loadURL(fixtureUrl);
    await until('!!window.fixture && !!document.querySelector(".browser-place")', 'BrowserView mounted', 5000);
    await until('fixture.snapshot().calls.some(call=>call.kind==="show")', 'the fully contained live page is shown', 5000);
    await frame();
    const scenario = new URL(fixtureUrl).search.slice(1);
    if (scenario !== 'full-window') assert.deepEqual(nativeBounds(await snapshot()), expected, 'at rest the native view matches its placeholder, ignoring a moving outer map');
    if (scenario === 'clipped') {
      win.webContents.sendInputEvent({ type:'mouseMove', x:700, y:400 });
      win.webContents.sendInputEvent({ type:'mouseWheel', x:700, y:400, deltaX:0, deltaY:-180, canScroll:true, hasPreciseScrollingDeltas:true });
      await until('fixture.snapshot().scrollTop>80', 'native wheel clips the placeholder');
      await frame(); await sleep(80);
      const state = await snapshot();
      const outside = state.calls.filter(call => call.bounds && (
        call.bounds.x < call.region.x || call.bounds.y < call.region.y ||
        call.bounds.x + call.bounds.width > call.region.x + call.region.width ||
        call.bounds.y + call.bounds.height > call.region.y + call.region.height
      ));
      assert.deepEqual(outside, [], 'no native show or bounds reaches outside the map');
      assert.deepEqual(state.calls.at(-1), { kind:'hide', pane:'preview', snapshot:true, region:state.region }, 'a partly clipped placeholder asks for a picture');
      assert.ok(state.picture?.startsWith('data:image/'), 'the picture is rendered in place of the native view');
    } else if (scenario === 'moving') {
      await run('fixture.moving(true)');
      await sleep(160); await frame();
      let state = await snapshot();
      assert.equal(state.calls.at(-1).kind, 'hide', 'adding only data-moving hides before the one-second fallback');
      assert.equal(state.calls.at(-1).snapshot, true, 'moving keeps a picture');
      assert.ok(state.picture, 'moving renders the picture');
      await run('fixture.moving(false)');
      await sleep(160); await frame();
      state = await snapshot();
      assert.equal(state.calls.at(-1).kind, 'show', 'removing only data-moving restores before the one-second fallback');
      assert.deepEqual(nativeBounds(state), expected);
      assert.equal(state.picture, null, 'the live page replaces the picture');
    } else if (scenario === 'focus-moving') {
      await run('fixture.pinned(true); fixture.clearCalls(); fixture.moving(true)');
      await sleep(160); await frame();
      let state = await snapshot();
      assert.deepEqual(state.calls, [], 'side-pane movement leaves the pinned live page untouched');
      assert.equal(state.picture, null, 'the pinned page stays live during side-pane movement');

      await run('fixture.focusMoving(true)');
      await sleep(120); await frame();
      state = await snapshot();
      assert.equal(state.calls.at(-1)?.kind, 'hide', 'adding only data-focus-moving promptly hides the pinned page');
      assert.equal(state.calls.at(-1)?.snapshot, true, 'Focus movement asks for a picture');
      assert.ok(state.picture, 'Focus movement renders the picture');

      await run('fixture.focusMoving(false)');
      await sleep(120); await frame();
      state = await snapshot();
      assert.equal(state.calls.at(-1)?.kind, 'show', 'clearing only data-focus-moving promptly restores the pinned page');
      assert.equal(state.picture, null, 'the pinned live page replaces its picture');

      await run('fixture.clearCalls(); fixture.pinned(false)');
      await sleep(120); await frame();
      state = await snapshot();
      assert.equal(state.calls.at(-1)?.kind, 'hide', 'lifting the Focus pane immediately uses the moving map guard');
      assert.ok(state.picture, 'the lifted pane keeps a picture');

      await run('fixture.pinned(true)');
      await sleep(120); await frame();
      state = await snapshot();
      assert.equal(state.calls.at(-1)?.kind, 'show', 'pinning again immediately returns to the settled Focus guard');
      assert.deepEqual(nativeBounds(state), expected);
    } else if (scenario === 'transition') {
      await run('fixture.glide().then(()=>true)');
      await sleep(120); await frame();
      assert.deepEqual(nativeBounds(await snapshot()), { x:530, y:160, width:300, height:200 }, 'transitionend updates final native bounds within 300ms');
    } else if (scenario === 'scrollend') {
      await run('fixture.scrollEndGeometry()');
      await sleep(120); await frame();
      assert.deepEqual(nativeBounds(await snapshot()), { x:530, y:160, width:300, height:200 }, 'captured scrollend updates final native bounds before fallback');
    } else if (scenario === 'full-window') {
      const docked = (await snapshot()).placeholder;
      await run(`document.querySelector('[aria-label="Full window"]').click()`);
      await frame(); await sleep(120);
      let state = await snapshot();
      assert.equal(await run('!!document.querySelector(".preview.full-window")'), true, 'the real PreviewPane enters full window');
      assert.deepEqual(await run('(()=>{const r=document.querySelector(".preview.full-window").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()'), {x:0,y:0,width:1200,height:800}, 'the Preview layer fills the window');
      assert.notEqual(state.calls.at(-1).kind, 'hide', 'full-window Preview stays live beyond the docked map bounds');
      assert.deepEqual(nativeBounds(state), state.placeholder, 'full-window native bounds follow its actual browser placeholder');
      await run('fixture.moving(true)'); await frame(); await sleep(120);
      assert.notEqual((await snapshot()).calls.at(-1).kind, 'hide', 'a moving map behind the full-window Preview does not cover it');

      await run('(()=>{const menu=document.createElement("div");menu.id="fixture-menu";menu.setAttribute("role","menu");Object.assign(menu.style,{position:"fixed",left:"100px",top:"100px",width:"100px",height:"100px"});document.body.append(menu)})()');
      await frame(); await sleep(80);
      state = await snapshot();
      assert.equal(state.calls.at(-1).kind, 'hide', 'a menu still covers the full-window native page');
      assert.ok(state.picture, 'the full-window page snapshots for its menu');
      await run('document.getElementById("fixture-menu").remove()'); await frame(); await sleep(80);
      assert.equal((await snapshot()).calls.at(-1).kind, 'show', 'closing the menu restores the full-window page');

      await run(`document.querySelector('[aria-label="Back to the deck"]').click()`);
      await frame(); await sleep(80);
      state = await snapshot();
      assert.equal(state.calls.at(-1).kind, 'hide', 'returning to a moving dock reinstates the map guard');
      assert.ok(state.picture, 'the returned dock keeps a picture until movement ends');
      await run('fixture.moving(false)'); await frame(); await sleep(80);
      state = await snapshot();
      assert.equal(state.calls.at(-1).kind, 'show', 'the docked page returns when the map settles');
      assert.deepEqual(nativeBounds(state), docked, 'returning restores the original docked placeholder bounds');
    } else {
      assert.fail('unknown scenario ' + scenario);
    }
    console.log('BrowserView map guard passed: ' + scenario);
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack);
    win.destroy(); app.exit(1);
  }
});
