(function(){
  var SIZE = 56, TAB = 6, SNAP_MS = 560;
  var FLASH_MS = {added: 1200, duplicate: 1200, failed: 1600};
  var PICK = {mint:'#3def91', cyan:'#1ed7ee', violet:'#a78bfa', amber:'#fbbf24'};
  var SHAPES = {orb:'Orb', bot:'Bot', blob:'Blob'};
  var PULSE = {'new':1, watching:1, checking:1, needs:1};
  var DRAG_TYPE = 'application/x-apex-drag';
  var wrap = null, hit = null, tipEl = null, menuEl = null, needsEl = null, flashEl = null;
  var lastCheck = Date.now() - 4*60*1000, checkTimer = null, snapTimer = null, flashTimer = null;
  var busy = false, dragging = false, dropOn = false, menuOn = false, g = null, suppressClick = false;
  var adding = false, flashing = false, lastMenu = '';
  var editors = [];

  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
  function look(){
    var l = AA.state.look || {};
    return { name: l.name || 'Apex', shape: l.shape || 'orb', color: l.color || 'mint',
             eyes: l.eyes !== false, glasses: !!l.glasses };
  }
  function project(){ return (AA.state.projects || []).filter(function(p){ return p.id === AA.state.project; })[0] || null; }
  function ago(){
    var m = Math.round((Date.now() - lastCheck) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }
  function needsPhrase(){
    var parts = [];
    AA.state.projects.forEach(function(p){
      var k = AA.view(p.id).needs || 0;
      if (k > 0) parts.push(k + ' in ' + p.name);
    });
    var n = AA.totalNeeds();
    return (n === 1 ? '1 needs you' : n + ' need you') + ' · ' + parts.join(', ');
  }
  function phrase(){
    var s = AA.state, st = s.status, p = project(), pn = p ? p.name : 'your project';
    if (AA.totalNeeds() > 0) return needsPhrase();
    if (s.hidden) return 'still working on ' + pn + ' · click to show';
    if (st === 'new') return 'just met you';
    if (st === 'checking') return 'checking ' + pn + ' now';
    if (st === 'needs') return 'needs a look';
    if (st === 'paused') return 'paused on ' + pn;
    if (st === 'offline') return 'offline, can’t reach ' + (p ? p.machine : 'the machine');
    return 'watching ' + pn + ' · last check ' + ago();
  }
  function tipText(lk){ return lk.name + ' · ' + phrase() + ' · ⌘K'; }

  /* ---------- markup ---------- */
  function shapeClass(lk){
    return 'av-shape av-look-' + lk.shape + (lk.eyes ? ' av-eyes-on' : '') + (lk.glasses ? ' av-glasses-on' : '');
  }
  function shapeHTML(lk){
    return '<span class="' + shapeClass(lk) + '">' +
      '<span class="av-b-orb"></span>' +
      '<span class="av-b-bot"></span><span class="av-ant"></span>' +
      '<span class="av-b-blob"></span>' +
      '<span class="av-eye av-eye-l"></span><span class="av-eye av-eye-r"></span>' +
      '<span class="av-glass av-glass-l"></span><span class="av-glass av-glass-r"></span><span class="av-bridge"></span>' +
      '</span>';
  }
  function miniFor(lk, size){
    return '<span class="av-mini av-scope av-c-' + lk.color + '" style="--av-s:' + size + 'px" aria-hidden="true">' + shapeHTML(lk) + '</span>';
  }
  function wrapHTML(){
    var lk = look();
    return '<div class="av-wrap av-scope av-c-' + lk.color + ' av-edge-right av-st-new">' +
      '<span class="av-halo"></span><span class="av-swirl"></span><span class="av-spin"></span>' +
      '<span class="av-open-ring"></span><span class="av-drop-ring"></span><span class="av-offring"></span>' +
      '<button class="av-hit" type="button" aria-label="Apex" aria-haspopup="menu" aria-expanded="false"><span class="av-tabbar"></span>' + shapeHTML(lk) + '</button>' +
      '<span class="av-hi">✦ Hi</span><span class="av-needs">0</span><span class="av-pause"></span><span class="av-offdot"></span>' +
      '<div class="av-drop-label aa-overlay">Drop to watch</div>' +
      '<div class="av-flash aa-overlay" role="status" aria-live="polite"></div>' +
      '<div class="av-tip aa-overlay" role="tooltip"></div>' +
      '<div class="av-menu aa-overlay" role="menu"></div>' +
      '</div>';
  }
  function menuItem(act, label, kbd){
    return '<button type="button" class="av-mi" role="menuitem" data-act="' + act + '"><span>' + label + '</span>' +
      (kbd ? '<kbd class="aa-kbd">' + kbd + '</kbd>' : '') + '</button>';
  }
  function menuHTML(){
    var s = AA.state, paused = s.status === 'paused';
    return menuItem('open', s.open ? 'Close chat' : 'Open chat', '⌘K') + menuItem('check', 'Check now') +
      menuItem('pause', paused ? 'Resume' : 'Pause') + '<div class="av-mi-sep"></div>' +
      menuItem('hide', 'Hide for now') + menuItem('move', 'Move to other side');
  }

  /* ---------- geometry: position only from AA.avatarBox() ---------- */
  function boxFor(edge, y){ // exactly what AA.avatarBox() returns for {edge, y}, without moving the avatar
    var saved = AA.state.pos;
    AA.state.pos = {edge: edge, y: y};
    try { return AA.avatarBox(); } finally { AA.state.pos = saved; }
  }
  function tabLeft(edge, box){ return edge === 'right' ? box.left + box.size + AA.EDGE - TAB : 0; }
  function dragBounds(){
    var L = AA.layer(), b = AA.browserRect(), A = AA.AVATAR, E = AA.EDGE;
    return {minX: E, maxX: Math.max(E, (b ? b.left : L.width) - A - E), minY: E, maxY: Math.max(E, L.height - A - E)};
  }
  function place(){
    var s = AA.state, box = AA.avatarBox();
    wrap.style.right = 'auto';
    wrap.style.left = (s.hidden ? tabLeft(s.pos.edge, box) : box.left) + 'px';
    wrap.style.top = box.top + 'px';
  }

  /* ---------- avatar state ---------- */
  function update(){
    if (!wrap) return;
    var s = AA.state, lk = look(), st = s.status || 'watching', n = AA.totalNeeds();
    var amber = n > 0 && st !== 'offline', pulse = n > 0 && !!PULSE[st];
    var tone = st === 'offline' ? 'grey' : (amber ? 'amber' : '');
    wrap.className = ['av-wrap', 'av-scope', 'av-c-' + lk.color, 'av-edge-' + s.pos.edge, 'av-st-' + st,
      pulse ? 'av-st-needs' : '', tone ? 'av-tone-' + tone : '', s.hidden ? 'av-is-tab' : '',
      s.open ? 'av-is-open' : '', n > 0 ? 'av-has-needs' : '', dropOn ? 'av-is-drop' : '',
      dragging ? 'av-is-drag' : '', busy ? 'av-is-snapping' : '', menuOn ? 'av-menu-on' : '',
      adding ? 'av-is-adding' : '', flashing ? 'av-is-flashing' : ''].filter(Boolean).join(' ');
    wrap.querySelector('.av-shape').className = shapeClass(lk);
    if (!busy && !dragging) place();
    hit.setAttribute('aria-label', lk.name + ' — ' + phrase() + '. Press Enter to ' + (s.open ? 'close' : 'open'));
    hit.setAttribute('aria-expanded', s.open || menuOn ? 'true' : 'false');
    needsEl.textContent = n;
    tipEl.textContent = tipText(lk);
    if (menuOn) { var h = menuHTML(); if (h !== lastMenu) { menuEl.innerHTML = h; lastMenu = h; } placeMenu(); }
  }

  /* ---------- menu ---------- */
  function placeMenu(){
    var L = AA.layer(), r = wrap.getBoundingClientRect(), h = menuEl.offsetHeight;
    var top = clamp(r.top - L.top - 6, AA.EDGE, Math.max(AA.EDGE, L.height - h - AA.EDGE));
    menuEl.style.top = (top - (r.top - L.top)) + 'px';
  }
  function openMenu(fromKey){
    menuOn = true; lastMenu = menuHTML(); menuEl.innerHTML = lastMenu;
    menuEl.classList.add('av-is-shown'); update();
    if (fromKey) { var f = menuEl.querySelector('.av-mi'); if (f) f.focus(); }
  }
  function closeMenu(){
    if (!menuOn) return;
    var inside = menuEl.contains(document.activeElement);
    menuOn = false; menuEl.classList.remove('av-is-shown'); update();
    if (inside) hit.focus();
  }
  function onMenuClick(e){
    var b = e.target.closest('.av-mi'); if (!b) return;
    var act = b.getAttribute('data-act'); closeMenu();
    if (act === 'open') AA.set({open: !AA.state.open, hidden: false});
    else if (act === 'check') checkNow();
    else if (act === 'pause') AA.set({status: AA.state.status === 'paused' ? 'watching' : 'paused'});
    else if (act === 'hide') AA.set({hidden: true});
    else if (act === 'move') springTo(AA.state.pos.edge === 'right' ? 'left' : 'right', AA.state.pos.y);
  }
  function onMenuKey(e){
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var items = [].slice.call(menuEl.querySelectorAll('.av-mi')); if (!items.length) return;
    e.preventDefault();
    var down = e.key === 'ArrowDown', i = items.indexOf(document.activeElement), j;
    if (i < 0) j = down ? 0 : items.length - 1;
    else j = (i + (down ? 1 : -1) + items.length) % items.length;
    items[j].focus();
  }
  function checkNow(){
    var st = AA.state.status;
    if (st === 'checking') return;
    var back = st === 'paused' ? 'paused' : 'watching';
    AA.set({status: 'checking'});
    clearTimeout(checkTimer);
    checkTimer = setTimeout(function(){
      lastCheck = Date.now();
      if (AA.state.status === 'checking') AA.set({status: back});
    }, 2500);
  }

  /* ---------- flash label (adding / added / failed / duplicate) ---------- */
  function showFlash(text, tone, ms){
    if (!flashEl) return;
    clearTimeout(flashTimer);
    flashEl.textContent = text;
    flashEl.className = 'av-flash aa-overlay av-is-shown' + (tone ? ' av-flash-' + tone : '');
    flashing = true; update();
    if (ms) flashTimer = setTimeout(hideFlash, ms);
  }
  function hideFlash(){
    clearTimeout(flashTimer);
    if (flashEl) flashEl.classList.remove('av-is-shown');
    flashing = false; update();
  }
  function onSourceAdd(p){
    if (!wrap || !p) return;
    if (p.phase === 'adding') { adding = true; showFlash('Adding…', '', 0); }
    else if (p.phase === 'added') { adding = false; showFlash('Added', '', FLASH_MS.added); }
    else if (p.phase === 'failed') { adding = false; showFlash('Couldn’t add', 'amber', FLASH_MS.failed); }
    else if (p.phase === 'duplicate') { adding = false; showFlash('Already watching', '', FLASH_MS.duplicate); }
    else return;
    update();
  }

  /* ---------- drag, snap, click ---------- */
  function springTo(edge, y){
    var L = AA.layer(), r = wrap.getBoundingClientRect(), hid = AA.state.hidden;
    var box = boxFor(edge, y);
    var tx = hid ? tabLeft(edge, box) : box.left, ty = box.top;
    busy = true; dragging = false;
    wrap.classList.remove('av-is-drag');
    wrap.style.left = (r.left - L.left) + 'px'; wrap.style.top = (r.top - L.top) + 'px';
    void wrap.offsetWidth;                       // start the spring from where the drag ended
    wrap.classList.add('av-is-snapping');
    wrap.style.left = tx + 'px'; wrap.style.top = ty + 'px';
    clearTimeout(snapTimer);
    snapTimer = setTimeout(function(){
      busy = false;
      AA.set({pos: {edge: edge, y: ty}});        // ty is exactly what AA.avatarBox() gives for this pos
    }, SNAP_MS);
  }
  function onDown(e){
    if (e.button !== 0 || busy) return;
    closeMenu();
    suppressClick = false;
    var L = AA.layer(), r = wrap.getBoundingClientRect();
    g = {x: e.clientX, y: e.clientY, left: r.left - L.left, top: r.top - L.top, moved: false, id: e.pointerId};
    try { hit.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function onMove(e){
    if (!g) return;
    var dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      g.moved = true; dragging = true; wrap.classList.add('av-is-drag');
    }
    var bd = dragBounds();
    wrap.style.left = clamp(g.left + dx, bd.minX, bd.maxX) + 'px';
    wrap.style.top = clamp(g.top + dy, bd.minY, bd.maxY) + 'px';
    wrap.style.right = 'auto';
  }
  function onUp(e){
    if (!g) return;
    var gg = g; g = null;
    try { hit.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!gg.moved) return;                       // a plain tap: the click event does the toggling
    suppressClick = true;                        // the browser still fires click after a drag
    var L = AA.layer(), r = wrap.getBoundingClientRect(), bd = dragBounds();
    var edge = (r.left - L.left + SIZE / 2) < L.width / 2 ? 'left' : 'right';
    springTo(edge, clamp(r.top - L.top, bd.minY, bd.maxY));
  }
  function onCancel(){
    g = null; dragging = false; wrap.classList.remove('av-is-drag'); update();
  }
  function onClick(){
    if (suppressClick) { suppressClick = false; return; }
    AA.set({open: !AA.state.open, hidden: false});
  }

  /* ---------- keyboard ---------- */
  function onHitKey(e){
    var s = AA.state, k = e.key;
    if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) { e.preventDefault(); openMenu(true); return; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      var bd = dragBounds(), top = AA.avatarBox().top;
      AA.set({pos: {edge: s.pos.edge, y: clamp(top + (k === 'ArrowUp' ? -24 : 24), bd.minY, bd.maxY)}});
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      AA.set({pos: {edge: k === 'ArrowLeft' ? 'left' : 'right', y: AA.avatarBox().top}});
    }
  }
  function onKey(e){
    if (e.key === 'Escape') {
      if (menuOn) { e.preventDefault(); closeMenu(); hit.focus(); return; }
      if (AA.state.open) { e.preventDefault(); AA.set({open: false}); hit.focus(); }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      var open = !AA.state.open;
      AA.set({open: open, hidden: false});
      if (open) { var ta = document.querySelector('#cv-mount textarea'); if (ta) ta.focus(); }
    }
  }

  /* ---------- drop target ---------- */
  function isApexDrag(e){
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, DRAG_TYPE) >= 0;
  }
  function setDrop(on){
    dropOn = on; update();
  }
  function onDragStart(e){
    var el = e.target && e.target.closest ? e.target.closest('[data-aa-drag]') : null;
    if (!el || !e.dataTransfer) return;
    var raw = el.getAttribute('data-aa-drag');
    e.dataTransfer.setData(DRAG_TYPE, raw);
    e.dataTransfer.setData('text/plain', raw);
    e.dataTransfer.effectAllowed = 'copy';
  }

  /* ---------- mount ---------- */
  function mount(){
    var host = document.getElementById('av-mount');
    if (!host) return;
    host.innerHTML = wrapHTML();
    wrap = host.querySelector('.av-wrap');
    hit = wrap.querySelector('.av-hit');
    tipEl = wrap.querySelector('.av-tip');
    menuEl = wrap.querySelector('.av-menu');
    needsEl = wrap.querySelector('.av-needs');
    flashEl = wrap.querySelector('.av-flash');

    hit.addEventListener('pointerdown', onDown);
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerup', onUp);
    hit.addEventListener('pointercancel', onCancel);
    hit.addEventListener('click', onClick);
    hit.addEventListener('keydown', onHitKey);
    wrap.addEventListener('contextmenu', function(e){ e.preventDefault(); openMenu(false); });
    menuEl.addEventListener('click', onMenuClick);
    menuEl.addEventListener('keydown', onMenuKey);
    document.addEventListener('pointerdown', function(e){ if (menuOn && !wrap.contains(e.target)) closeMenu(); }, true);

    wrap.addEventListener('dragover', function(e){
      if (!isApexDrag(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDrop(true);
    });
    wrap.addEventListener('dragleave', function(e){ if (!wrap.contains(e.relatedTarget)) setDrop(false); });
    wrap.addEventListener('drop', function(e){
      if (!isApexDrag(e)) return;
      e.preventDefault(); setDrop(false);
      var raw = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData('text/plain') || '{}';
      var obj = {}; try { obj = JSON.parse(raw) || {}; } catch (_) {}
      if (obj.kind && obj.ref) AA.addSource(obj);   // 'source-add' events tell the story from here
    });
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', function(){ update(); });
    setInterval(function(){ if (wrap) update(); }, 30000);
    update();
  }

  /* ---------- "Make it yours" editor ---------- */
  function slug(s){ return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'apex'; }
  function setLook(patch){ AA.set({look: Object.assign({}, look(), patch)}); }
  function editorHTML(){
    return '<div class="av-ed">' +
      '<div class="av-ed-top"><span class="av-ed-prev" data-role="prev"></span>' +
        '<div class="av-ed-who"><div class="av-ed-handle" data-role="handle"></div>' +
        '<div class="av-ed-sub">Your Apex. Only you see this.</div></div></div>' +
      '<label class="av-ed-field"><span class="av-ed-label">Name</span>' +
        '<input class="av-ed-name" data-role="name" maxlength="20" spellcheck="false" autocomplete="off"></label>' +
      '<div class="av-ed-label">Shape</div><div class="av-ed-choices" data-role="shape"></div>' +
      '<div class="av-ed-label">Color</div><div class="av-ed-swatches" data-role="color"></div>' +
      '<div class="av-ed-toggles">' +
        '<button type="button" class="av-ed-toggle" data-kind="eyes" aria-pressed="false">Eyes</button>' +
        '<button type="button" class="av-ed-toggle" data-kind="glasses" aria-pressed="false">Glasses</button>' +
      '</div></div>';
  }
  function syncEditor(ed){
    var el = ed.el, lk = look();
    var input = el.querySelector('[data-role=name]');
    if (input && document.activeElement !== input && input.value !== lk.name) input.value = lk.name;
    var raw = input ? input.value : lk.name;
    el.querySelector('[data-role=handle]').textContent = '@tyler-' + slug(raw);
    el.querySelector('[data-role=prev]').innerHTML = miniFor(lk, 64);
    el.querySelector('[data-role=shape]').innerHTML = Object.keys(SHAPES).map(function(sh){
      var on = lk.shape === sh;
      return '<button type="button" class="av-ed-choice' + (on ? ' av-is-on' : '') + '" data-shape="' + sh +
        '" aria-pressed="' + on + '"><span class="av-ed-cprev">' + miniFor(Object.assign({}, lk, {shape: sh}), 34) +
        '</span><span>' + SHAPES[sh] + '</span></button>';
    }).join('');
    el.querySelector('[data-role=color]').innerHTML = Object.keys(PICK).map(function(c){
      var on = lk.color === c;
      return '<button type="button" class="av-ed-swatch' + (on ? ' av-is-on' : '') + '" data-color="' + c +
        '" aria-pressed="' + on + '" aria-label="' + c + '" style="--sw:' + PICK[c] + '"></button>';
    }).join('');
    el.querySelectorAll('[data-kind]').forEach(function(b){
      var on = !!lk[b.getAttribute('data-kind')];
      b.classList.toggle('av-is-on', on); b.setAttribute('aria-pressed', on);
    });
  }
  function renderLook(el){
    if (!el) return;
    editors = editors.filter(function(x){ return x.el.isConnected && x.el !== el; });
    var ed = {el: el};
    el.innerHTML = editorHTML();
    el.addEventListener('click', function(e){
      var b = e.target.closest('button'); if (!b || !el.contains(b)) return;
      if (b.hasAttribute('data-shape')) setLook({shape: b.getAttribute('data-shape')});
      else if (b.hasAttribute('data-color')) setLook({color: b.getAttribute('data-color')});
      else if (b.hasAttribute('data-kind')) { var k = b.getAttribute('data-kind'), o = {}; o[k] = !look()[k]; setLook(o); }
    });
    el.querySelector('[data-role=name]').addEventListener('input', function(e){ setLook({name: e.target.value.slice(0, 20)}); });
    editors.push(ed);
    syncEditor(ed);
  }
  function syncEditors(){
    editors = editors.filter(function(x){ return x.el.isConnected; });
    editors.forEach(syncEditor);
  }

  AA.on('change', function(){ update(); syncEditors(); });
  AA.on('source-add', onSourceAdd);
  AA.part('av', {
    mount: mount,
    mini: function(size){ return miniFor(look(), size || SIZE); },
    renderLook: renderLook
  });
})();
