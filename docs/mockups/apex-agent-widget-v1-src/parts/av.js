(function(){
  var MARGIN = 12, SIZE = 56, SNAP_MS = 560;
  var PICK = {mint:'#3def91', cyan:'#1ed7ee', violet:'#a78bfa', amber:'#fbbf24'};
  var SHAPES = {orb:'Orb', bot:'Bot', blob:'Blob'};
  var wrap = null, hit = null, tipEl = null, menuEl = null, needsEl = null;
  var lastCheck = Date.now() - 4*60*1000, checkTimer = null, snapTimer = null;
  var busy = false, dragging = false, dropOn = false, menuOn = false, g = null;
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
  function tipText(lk){
    var s = AA.state, st = s.status, p = project(), pn = p ? p.name : 'your project', n = lk.name;
    if (s.hidden) return 'Apex is still working · click to show';
    if (st === 'new') return n + ' · just met you · ⌘J to chat';
    if (st === 'checking') return n + ' · checking ' + pn + ' now · ⌘J';
    if (st === 'needs') return n + ' · ' + (s.needs > 0 ? 'needs you on ' + s.needs + (s.needs === 1 ? ' thing' : ' things') : 'needs a look') + ' · ⌘J';
    if (st === 'paused') return n + ' · paused on ' + pn + ' · ⌘J';
    if (st === 'offline') return n + ' · offline · can’t reach ' + (p ? p.machine : 'the machine') + ' · ⌘J';
    return n + ' · watching ' + pn + ' · last check ' + ago() + ' · ⌘J';
  }

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
      '<span class="av-halo"></span><span class="av-swirl"></span><span class="av-open-ring"></span>' +
      '<span class="av-drop-ring"></span><span class="av-offring"></span>' +
      '<button class="av-hit" type="button" aria-label="Apex"><span class="av-tabbar"></span>' + shapeHTML(lk) + '</button>' +
      '<span class="av-hi">✦ Hi</span><span class="av-needs">0</span><span class="av-pause"></span><span class="av-offdot"></span>' +
      '<div class="av-drop-label">Drop to watch</div>' +
      '<div class="av-tip" role="tooltip"></div>' +
      '<div class="av-menu" role="menu"></div>' +
      '</div>';
  }
  function menuItem(act, label, kbd){
    return '<button type="button" class="av-mi" role="menuitem" data-act="' + act + '"><span>' + label + '</span>' +
      (kbd ? '<kbd class="aa-kbd">' + kbd + '</kbd>' : '') + '</button>';
  }
  function menuHTML(){
    var paused = AA.state.status === 'paused';
    return menuItem('open', 'Open chat', '⌘J') + menuItem('check', 'Check now') +
      menuItem('pause', paused ? 'Resume' : 'Pause') + '<div class="av-mi-sep"></div>' +
      menuItem('hide', 'Hide for now') + menuItem('move', 'Move to other side');
  }

  /* ---------- avatar state ---------- */
  function update(){
    if (!wrap) return;
    var s = AA.state, lk = look(), st = s.status || 'watching';
    var tone = st === 'offline' ? 'grey' : (st === 'needs' || (s.hidden && s.needs > 0)) ? 'amber' : '';
    wrap.className = ['av-wrap', 'av-scope', 'av-c-' + lk.color, 'av-edge-' + s.pos.edge, 'av-st-' + st,
      tone ? 'av-tone-' + tone : '', s.hidden ? 'av-is-tab' : '', s.open ? 'av-is-open' : '',
      s.needs > 0 ? 'av-has-needs' : '', dropOn ? 'av-is-drop' : '', dragging ? 'av-is-drag' : '',
      busy ? 'av-is-snapping' : '', menuOn ? 'av-menu-on' : ''].filter(Boolean).join(' ');
    wrap.querySelector('.av-shape').className = shapeClass(lk);
    if (!busy && !dragging) {
      var L = AA.layer();
      var y = clamp(s.pos.y, MARGIN, Math.max(MARGIN, L.height - SIZE - MARGIN));
      wrap.style.left = ''; wrap.style.right = ''; wrap.style.top = y + 'px';
    }
    hit.setAttribute('aria-label', lk.name + ': ' + tipText(lk));
    needsEl.textContent = s.needs;
    tipEl.textContent = tipText(lk);
    if (menuOn) { menuEl.innerHTML = menuHTML(); placeMenu(); }
  }

  /* ---------- menu ---------- */
  function placeMenu(){
    var L = AA.layer(), r = wrap.getBoundingClientRect(), h = menuEl.offsetHeight;
    var top = clamp(r.top - L.top - 6, MARGIN, Math.max(MARGIN, L.height - h - MARGIN));
    menuEl.style.top = (top - (r.top - L.top)) + 'px';
  }
  function openMenu(){
    menuOn = true; wrap.classList.add('av-menu-on');
    menuEl.innerHTML = menuHTML(); menuEl.classList.add('av-is-shown'); placeMenu();
  }
  function closeMenu(){
    if (!menuOn) return;
    menuOn = false; wrap.classList.remove('av-menu-on'); menuEl.classList.remove('av-is-shown');
  }
  function onMenuClick(e){
    var b = e.target.closest('.av-mi'); if (!b) return;
    var act = b.getAttribute('data-act'); closeMenu();
    if (act === 'open') AA.set({open: true, hidden: false});
    else if (act === 'check') checkNow();
    else if (act === 'pause') AA.set({status: AA.state.status === 'paused' ? 'watching' : 'paused'});
    else if (act === 'hide') AA.set({hidden: true});
    else if (act === 'move') springTo(AA.state.pos.edge === 'right' ? 'left' : 'right', AA.state.pos.y);
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

  /* ---------- drag, snap, click ---------- */
  function springTo(edge, y){
    var L = AA.layer(), r = wrap.getBoundingClientRect(), inset = AA.state.hidden ? 0 : MARGIN;
    var tx = edge === 'left' ? inset : L.width - r.width - inset;
    busy = true; dragging = false;
    wrap.classList.remove('av-is-drag');
    wrap.style.left = (r.left - L.left) + 'px'; wrap.style.right = 'auto';
    wrap.style.top = (r.top - L.top) + 'px';
    void wrap.offsetWidth;                       // start the spring from where the drag ended
    wrap.classList.add('av-is-snapping');
    wrap.style.left = tx + 'px'; wrap.style.top = y + 'px';
    clearTimeout(snapTimer);
    snapTimer = setTimeout(function(){
      busy = false; wrap.classList.remove('av-is-snapping');
      AA.set({pos: {edge: edge, y: Math.round(y)}});   // update() clears the inline position
    }, SNAP_MS);
  }
  function onDown(e){
    if (e.button !== 0 || busy) return;
    closeMenu();
    var L = AA.layer(), r = wrap.getBoundingClientRect();
    g = {x: e.clientX, y: e.clientY, left: r.left - L.left, top: r.top - L.top, w: r.width, moved: false, id: e.pointerId};
    try { hit.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function onMove(e){
    if (!g) return;
    var dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      g.moved = true; dragging = true; wrap.classList.add('av-is-drag');
    }
    var L = AA.layer();
    var nx = clamp(g.left + dx, 0, L.width - g.w), ny = clamp(g.top + dy, MARGIN, L.height - SIZE - MARGIN);
    wrap.style.left = nx + 'px'; wrap.style.right = 'auto'; wrap.style.top = ny + 'px';
  }
  function onUp(e){
    if (!g) return;
    var gg = g; g = null;
    try { hit.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!gg.moved) {
      if (AA.state.hidden) AA.set({hidden: false});
      else AA.set({open: !AA.state.open});
      return;
    }
    var L = AA.layer(), r = wrap.getBoundingClientRect();
    var edge = (r.left - L.left + r.width / 2) < L.width / 2 ? 'left' : 'right';
    var y = clamp(Math.round(r.top - L.top), MARGIN, L.height - SIZE - MARGIN);
    springTo(edge, y);
  }
  function onCancel(){
    g = null; dragging = false; wrap.classList.remove('av-is-drag'); update();
  }

  /* ---------- drop target ---------- */
  var DRAG_TYPE = 'application/x-apex-drag';
  function isApexDrag(e){
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, DRAG_TYPE) >= 0;
  }
  function setDrop(on){
    dropOn = on; wrap.classList.toggle('av-is-drop', on);
  }
  function onDragStart(e){
    var el = e.target && e.target.closest ? e.target.closest('[data-aa-drag]') : null;
    if (!el || !e.dataTransfer) return;
    var raw = el.getAttribute('data-aa-drag');
    var obj = {}; try { obj = JSON.parse(raw) || {}; } catch (_) {}
    e.dataTransfer.setData(DRAG_TYPE, raw);
    e.dataTransfer.setData('text/plain', obj.label || '');
    e.dataTransfer.effectAllowed = 'copy';
  }

  /* ---------- keyboard ---------- */
  function onKey(e){
    if (e.key === 'Escape' && menuOn) { closeMenu(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      var s = AA.state;
      if (s.hidden) AA.set({hidden: false, open: true});
      else AA.set({open: !s.open});
    }
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

    hit.addEventListener('pointerdown', onDown);
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerup', onUp);
    hit.addEventListener('pointercancel', onCancel);
    wrap.addEventListener('contextmenu', function(e){ e.preventDefault(); openMenu(); });
    menuEl.addEventListener('click', onMenuClick);
    document.addEventListener('pointerdown', function(e){ if (menuOn && !wrap.contains(e.target)) closeMenu(); }, true);

    wrap.addEventListener('dragover', function(e){
      if (!isApexDrag(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDrop(true);
    });
    wrap.addEventListener('dragleave', function(e){ if (!wrap.contains(e.relatedTarget)) setDrop(false); });
    wrap.addEventListener('drop', function(e){
      if (!isApexDrag(e)) return;
      e.preventDefault(); setDrop(false);
      var obj = {}; try { obj = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '{}') || {}; } catch (_) {}
      AA.emit('source-dropped', obj);
      AA.bubble({id: 'drop', tone: 'routine', text: 'Got it — I\'ll watch ' + (obj.label || 'that') + '.'});
    });
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', function(){ update(); });
    setInterval(function(){ if (wrap) tipEl.textContent = tipText(look()); }, 30000);
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
  AA.part('av', {
    mount: mount,
    mini: function(size){ return miniFor(look(), size || SIZE); },
    renderLook: renderLook
  });
})();
