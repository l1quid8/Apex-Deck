const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:false, width:1200, height:800, useContentSize:true, enableLargerThanScreen:true, webPreferences:{ offscreen:true, backgroundThrottling:false } });
  // Restore the fixture bounds after Windows centers and clamps the constructor bounds.
  win.setContentSize(1200, 800);
  const run = code => win.webContents.executeJavaScript(code);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const snapshot = () => run('fixture.snapshot()');
  const until = async (condition, note, duration = 500) => {
    const end = Date.now() + duration;
    while (Date.now() < end) {
      if (await run(condition)) return;
      await sleep(12);
    }
    assert.fail(note + ': ' + JSON.stringify(await snapshot()));
  };
  const input = event => win.webContents.sendInputEvent(event);
  const mouse = (type, x, y) => input({ type, x:Math.round(x), y:Math.round(y), ...(type === 'mouseMove' ? {} : { button:'left', clickCount:1 }) });
  const noOutsideBounds = state => assert.deepEqual(state.calls.filter(call => call.bounds && (
    call.bounds.x < call.region.x || call.bounds.y < call.region.y ||
    call.bounds.x + call.bounds.width > call.region.x + call.region.width ||
    call.bounds.y + call.bounds.height > call.region.y + call.region.height
  )), [], 'no native show or bounds extends outside the map');
  const focusIsShown = '["show","bounds"].includes(fixture.snapshot().calls.filter(c=>c.pane==="p0").at(-1)?.kind) && !fixture.snapshot().panes.p0.picture';
  const focusHasPicture = 'fixture.snapshot().calls.some(c=>c.pane==="p0" && c.kind==="hide" && c.snapshot) && !!fixture.snapshot().panes.p0.picture';
  const reset = async () => {
    await run('window.resetFrom = fixture.snapshot().arrangement; fixture.reset()');
    await until('fixture.snapshot().arrangement !== window.resetFrom', 'reset renders', 1000);
    await until('!fixture.snapshot().moving && !fixture.snapshot().focusMoving', 'reset settles', 1000);
    await frame();
    await run('fixture.clearCalls()');
  };
  const restored = async (note, budget = 300) => {
    await until(focusIsShown, note + ' restores the live Focus page within ' + budget + 'ms', budget);
    const state = await snapshot();
    const bounds = state.calls.filter(call => call.pane === 'p0' && (call.kind === 'show' || call.kind === 'bounds')).at(-1).bounds;
    const actual = state.panes.p0.placeholder;
    assert.deepEqual(bounds, { x:Math.round(actual.x), y:Math.round(actual.y), width:Math.round(actual.width), height:Math.round(actual.height) }, note + ' restores at the final placeholder');
    noOutsideBounds(state);
  };
  try {
    await win.loadURL(fixtureUrl);
    await until('!!window.fixture && fixture.snapshot().calls.filter(c=>c.kind==="show").length>=2 && !fixture.snapshot().moving && !fixture.snapshot().focusMoving', 'both real BrowserViews settle in the real map', 5000);
    await frame();
    await run('fixture.clearCalls()');
    // Put p1 on the second visible row so a scrolled refit exercises a live view.
    await run('fixture.setOrder(["p0","p2","p3","p1","p4","p5","p6","p7","p8","p9","p10","p11","p12","p13"])');
    await sleep(350);
    await run('document.querySelector("[data-pane-map-region]").scrollTop=808/3');
    await sleep(350); await frame();
    await run('fixture.clearCalls()');
    for (let i=1;i<=9;i++) {
      await run('fixture.grow('+i*12+')'); await frame(); await sleep(25);
      const state = await snapshot();
      assert.equal(state.moving, false, 'a scrolled refit is quiet');
      assert.deepEqual(state.calls.filter(c=>c.kind==='hide'), [], 'scrolled refit keeps previews live');
    }
    assert.ok((await snapshot()).calls.some(c=>c.pane==='p1' && c.kind==='bounds'));
    await run('fixture.grow(0)'); await reset();
    for (let i=1;i<=9;i++) {
      await run('fixture.grow('+i*12+')'); await frame(); await sleep(25);
      const grown = await snapshot();
      assert.deepEqual(grown.calls.filter(c=>c.kind==='hide'), [], 'composer refit never hides a live preview');
      assert.equal(grown.moving,false); assert.equal(grown.focusMoving,false);
    }
    assert.ok((await snapshot()).calls.some(c=>c.kind==='bounds'), 'refit updates native bounds');
    await run('fixture.grow(0)'); await frame(); await sleep(100); await run('fixture.clearCalls()');
    const before = await snapshot();
    assert.equal(before.panes.p0.pinned, true, 'p0 is the sticky Focus pane');
    mouse('mouseMove', 1000, 400);
    for (let i = 0; i < 12; i++) {
      input({ type:'mouseWheel', x:1000, y:400, deltaX:0, deltaY:-45, canScroll:true, hasPreciseScrollingDeltas:true });
      await sleep(16);
    }
    await until('fixture.snapshot().scrollTop>0 && !fixture.snapshot().moving', '12 native wheel steps settle', 1000);
    await frame();
    let state = await snapshot();
    assert.deepEqual(state.calls.filter(call => call.pane === 'p0'), [], 'side-pane scrolling makes no hide, show or bounds call for p0');
    assert.deepEqual(state.panes.p0.placeholder, before.panes.p0.placeholder, 'the pinned placeholder holds still');
    const firstSideCall = state.calls.find(call => call.pane === 'p1');
    assert.equal(firstSideCall?.kind, 'hide', 'the first side-pane change hides its native page');
    assert.equal(firstSideCall?.snapshot, true, 'the scrolling side pane asks for a picture');
    assert.equal(firstSideCall?.scrollTop, 45, 'the side pane snapshots at the first native wheel position: ' + JSON.stringify(firstSideCall));
    assert.ok(state.panes.p1.picture, 'the side pane renders its picture');
    noOutsideBounds(state);

    await reset();
    await run('fixture.setMode("right")');
    await until(focusHasPicture, 'switching Focus side snapshots p0', 180);
    await run('Promise.all([...document.querySelectorAll(".pane-map-slot")].flatMap(slot=>slot.getAnimations()).map(animation=>animation.finished.catch(()=>{})))');
    await restored('Focus side switch');

    await reset();
    state = await snapshot();
    const dividerX = state.divider.x + state.divider.width / 2;
    mouse('mouseMove', dividerX, 400); mouse('mouseDown', dividerX, 400);
    mouse('mouseMove', dividerX + 60, 400);
    await until(focusHasPicture, 'native divider drag snapshots p0', 180);
    mouse('mouseUp', dividerX + 60, 400);
    await restored('Divider drag');

    // A side zoom retargets an incoming Focus glide without changing its final
    // rect. Its picture must cover the restarted animation's whole lifetime.
    await reset();
    await run('fixture.setMode("grid")');
    await until('!document.querySelector(".pane-map-divider") && !document.querySelector("[data-pane-map-region]").hasAttribute("data-moving")', 'grid settles before incoming Focus interruption', 1000);
    await frame();
    const interrupted = await run(`new Promise(resolve => {
      fixture.clearCalls(); fixture.setMode('right');
      const samples = [], start = performance.now(); let zoomed = false;
      const tick = time => {
        const map = document.querySelector('[data-pane-map-region]');
        const slot = map.querySelector('[data-pane-id=p0]');
        const glide = slot.getAnimations().find(animation => animation.constructor.name === 'Animation' && animation.playState === 'running');
        if (!zoomed && glide && glide.currentTime >= 80) {
          zoomed = true; map.focus();
          map.dispatchEvent(new KeyboardEvent('keydown', { key:'=', bubbles:true }));
        }
        samples.push({ gliding:!!glide, focusMoving:map.hasAttribute('data-focus-moving') });
        if (time - start < 500) requestAnimationFrame(tick); else resolve({ zoomed, samples });
      };
      requestAnimationFrame(tick);
    })`);
    assert.equal(interrupted.zoomed, true, 'side zoom interrupts a running incoming Focus glide');
    assert.deepEqual(interrupted.samples.filter(sample => sample.gliding && !sample.focusMoving), [], 'Focus snapshot guard lasts through the rebased incoming glide');
    await restored('Side zoom during incoming Focus glide');

    await reset();
    state = await snapshot();
    const title = state.panes.p1.rect;
    const titleX = title.x + 60;
    const titleY = title.y + 14;
    mouse('mouseMove', titleX, titleY); mouse('mouseDown', titleX, titleY);
    mouse('mouseMove', titleX - 40, titleY + 100);
    await until(focusHasPicture, 'a native side-pane title drag snapshots p0', 180);
    mouse('mouseUp', titleX - 40, titleY + 100);
    await until('!document.querySelector(".pane-map-slot.dragging")', 'native title release commits before timing restoration');
    await until('![...document.querySelectorAll(".pane-map-slot")].some(slot => slot.getAnimations().some(a=>a.playState==="running"))', 'drop glide ends', 1000);
    await restored('Title drag', 150);

    console.log('Focus BrowserView real map scroll, switch, divider and title drag passed');
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack);
    win.destroy(); app.exit(1);
  }
});
