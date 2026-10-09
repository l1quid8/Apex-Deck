/* bb: speech bubbles beside the floating avatar */
(function(){
  const ROUTINE_MS = 6000, FADE_MS = 3000, FAIL_MS = 6000, ADDING_MS = 600000, TICK = 200, MAX_VISIBLE = 3, GAP = 12, MARGIN = 8;
  const SNOOZE_TEXT = "Okay — I'll bring it back at 3:40 PM.";
  const MOON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const SPIN = '<span class="bb-spin" aria-hidden="true"></span>';
  let items = [];          // oldest -> newest; each item remembers the project it belongs to
  const els = new Map();   // id -> wrapper element
  let mount = null, stack = null, lastProject = null;

  const quietOn = () => !!(AA.state.quiet && AA.state.quiet.on);
  const quietTo = () => String((AA.state.quiet && AA.state.quiet.to) || '08:00').replace(/^0/, '');
  const projectName = id => ((AA.state.projects || []).find(p => p.id === id) || {}).name || 'Another project';
  // routine bubbles show only for the current project; decisions show from any project, with a label
  // a decision bubble belongs to one finding; once that finding is resolved, snoozed or gone, the bubble goes too
  const findingOpen = it => {
    if (!it.finding) return true;
    const m = (AA.view(it.project).messages || []).find(x => x.id === it.finding);
    return !!m && m.status === 'open';
  };
  const visibleItems = () => items.filter(i => i.tone === 'decision' ? findingOpen(i) : i.project === AA.state.project);
  const showLabel = it => it.tone === 'decision' && it.project !== AA.state.project;

  function inner(it, held){
    const e = AA.esc;
    const x = '<button class="bb-x" data-act="close" aria-label="Dismiss">×</button>';
    const label = showLabel(it) ? '<div class="bb-proj">' + e(projectName(it.project)) + ' ·</div>' : '';
    const row = '<div class="bb-row">' + (it.spin ? SPIN : '') + '<span class="bb-text">' + e(it.text) + '</span>' + x + '</div>';
    const sub = it.sub ? '<div class="bb-sub">' + e(it.sub) + '</div>' : '';
    if (it.tone !== 'decision') return label + row + sub;
    let h = label + row + sub;
    if (it.evidence && it.evidence.length) {
      h += '<div class="bb-chips">' + it.evidence.map(l => '<span class="bb-chip">' + e(l) + '</span>').join('') + '</div>';
    }
    if (held) h += '<div class="bb-held-line">' + MOON + '<span>Quiet hours — held for ' + e(quietTo()) + '</span></div>';
    if (it.phase === 'sent') return h + '<div class="bb-sent">Sent ✓</div>';
    h += '<div class="bb-reply"><input class="bb-input" type="text" placeholder="Reply…" aria-label="Reply to Apex">' +
      '<button class="aa-btn aa-btn-primary bb-send" data-act="send">Send</button></div>';
    h += '<div class="bb-actions"><button class="aa-btn bb-act" data-act="chat">Open chat</button>' +
      '<button class="aa-btn bb-act" data-act="snooze">Snooze 1h</button></div>';
    return h;
  }

  function build(it){
    const el = document.createElement('div');
    el.className = 'bb-item aa-overlay';
    el.dataset.id = it.id;
    el.addEventListener('pointerenter', () => { it.hover = true; });
    el.addEventListener('pointerleave', () => { it.hover = false; });
    el.addEventListener('focusin', () => { it.focus = true; });
    el.addEventListener('focusout', e => { if (!el.contains(e.relatedTarget)) it.focus = false; });
    el.addEventListener('animationend', e => { if (e.target === el) el.classList.remove('bb-enter'); });
    return el;
  }

  // Place the stack beside the avatar box: 12px clear of it, vertically centred on it, inside the layer.
  function place(){
    if (!stack || !mount) return;
    const st = AA.state, L = AA.layer(), a = AA.avatarBox();
    const right = st.pos.edge !== 'left';
    stack.style.left = ''; stack.style.right = ''; stack.style.top = '';
    if (right) stack.style.right = (L.width - a.left + GAP) + 'px';
    else stack.style.left = (a.left + a.size + GAP) + 'px';
    // never wider than the room between the avatar and the window edge
    const room = right ? a.left - GAP - MARGIN : L.width - (a.left + a.size + GAP) - MARGIN;
    stack.style.maxWidth = Math.max(0, Math.min(300, room)) + 'px';
    const vis = visibleItems().slice(-MAX_VISIBLE);
    if (st.open || !vis.length) return;
    const anchorY = a.top + a.size / 2;
    const h = stack.offsetHeight;
    const top = Math.max(8, Math.min(anchorY - h / 2, L.height - 8 - h));
    stack.style.top = top + 'px';
    const tail = Math.max(14, Math.min(anchorY - top, h - 14));
    stack.style.setProperty('--bb-tail', tail + 'px');
  }

  function render(){
    if (!mount || !stack) return;
    const st = AA.state;
    const held = quietOn();
    if (lastProject !== null && st.project !== lastProject) {
      // the human switched projects: routine bubbles from the old project go; decisions stay (labelled)
      items = items.filter(i => i.tone === 'decision' || i.project === st.project);
    }
    lastProject = st.project;
    items = items.filter(i => i.tone !== 'decision' || findingOpen(i));   // settled findings drop their bubble for good
    const vis = visibleItems().slice(-MAX_VISIBLE);
    const visIds = new Set(vis.map(i => i.id));

    // retire bubbles that are gone or pushed out of the stack
    for (const [id, el] of [...els]) {
      if (!visIds.has(id) && !el.classList.contains('bb-out')) {
        el.classList.add('bb-out');
        setTimeout(() => { if (el.isConnected) el.remove(); if (els.get(id) === el) els.delete(id); }, 220);
      }
    }

    vis.forEach((it, k) => {
      const isDecision = it.tone === 'decision';
      const isHeld = held && isDecision;
      let el = els.get(it.id);
      if (!el || el.classList.contains('bb-out') || el.dataset.tone !== it.tone) {
        if (el) el.remove();
        el = build(it);
        el.dataset.tone = it.tone;
        els.set(it.id, el);
        stack.appendChild(el);
        if (!isHeld) el.classList.add('bb-enter');   // held decisions appear without the pop
      }
      const sig = [it.phase, it.tone, it.text, it.sub || '', (it.evidence || []).join('|'), isHeld ? 1 : 0,
        it.spin ? 1 : 0, showLabel(it) ? it.project : '', it.warn ? 1 : 0].join('\u0001');
      if (el.dataset.sig !== sig) { el.innerHTML = inner(it, isHeld); el.dataset.sig = sig; }
      el.classList.toggle('bb-decision', isDecision);
      el.classList.toggle('bb-routine', !isDecision);
      el.classList.toggle('bb-warn', !!it.warn);
      el.classList.toggle('bb-held', isHeld);
      el.classList.toggle('bb-glow', isDecision && !isHeld);
      const depth = vis.length - 1 - k;
      el.classList.toggle('bb-d1', depth === 1);
      el.classList.toggle('bb-d2', depth >= 2);
    });

    // keep DOM order oldest (top) to newest (bottom)
    const want = vis.map(i => els.get(i.id));
    const cur = [...stack.children].filter(c => want.includes(c));
    if (cur.some((c, i) => c !== want[i])) want.forEach(el => stack.appendChild(el));

    stack.classList.toggle('bb-empty', !vis.length);
    stack.classList.toggle('bb-hide', !!st.open);
    stack.classList.toggle('bb-side-l', st.pos.edge === 'left');
    stack.classList.toggle('bb-side-r', st.pos.edge !== 'left');
    place();
  }

  function removeItem(id){
    items = items.filter(i => i.id !== id);
    render();
  }

  // add or update a bubble in place; it belongs to data.project, or to the project that is current right now
  function put(id, data, life){
    if (data.tone === 'routine' && quietOn()) return;   // quiet hours: routine stays silent
    const fields = Object.assign({tone:'routine', text:'', sub:'', evidence:[], spin:false, warn:false}, data,
      {project: data.project || AA.state.project, phase: 'pending', left: life});
    const found = items.find(i => i.id === id);
    if (found) Object.assign(found, fields);
    else items = [...items, Object.assign({id, hover:false, focus:false}, fields)];
    render();
  }

  function send(it, el){
    const inp = el && el.querySelector('.bb-input');
    const text = inp ? inp.value.trim() : '';
    if (!text) { if (inp) inp.focus(); return; }
    // post to the bubble's own project, switching first if needed
    if (it.project && it.project !== AA.state.project) AA.switchProject(it.project);
    AA.emit('user-message', text);
    AA.addMessage({from: 'me', kind: 'text', text});
    it.phase = 'sent';
    render();
    setTimeout(() => { if (items.includes(it)) removeItem(it.id); }, 1100);
  }

  function act(btn, it){
    const a = btn.dataset.act;
    if (a === 'close') return removeItem(it.id);
    if (a === 'chat') {
      if (it.project && it.project !== AA.state.project) AA.switchProject(it.project);
      return AA.set({open: true, tab: 'chat'});
    }
    if (a === 'snooze') { removeItem(it.id); return AA.bubble({id: 'snz', tone: 'routine', text: SNOOZE_TEXT}); }
    if (a === 'send') return send(it, btn.closest('.bb-item'));
  }

  const itemOf = target => {
    const el = target.closest && target.closest('.bb-item');
    return el ? items.find(i => i.id === el.dataset.id) : null;
  };

  AA.on('bubble', b => {
    if (!b || b.id == null) return;
    put(String(b.id), {
      tone: b.tone === 'decision' ? 'decision' : 'routine',
      text: b.text || '', sub: b.sub || '', evidence: b.evidence || [],
      finding: b.finding || null, project: b.project || AA.state.project
    }, ROUTINE_MS);
  });

  // drop feedback: one bubble per destination project, updated in place. It stays with the project the
  // drop was for, so switching projects mid-save never shows the result under the wrong project.
  AA.on('source-add', e => {
    if (!e || !e.label) return;
    const L = e.label, project = e.project || AA.state.project, id = 'src-add:' + project;
    if (e.phase === 'adding') return put(id, {project, spin: true, text: 'Adding ' + L + '…'}, ADDING_MS);
    if (e.phase === 'added') return put(id, {project, text: 'Added ' + L + '. I\'ll watch it from now on.'}, FADE_MS);
    if (e.phase === 'duplicate') return put(id, {project, text: 'I\'m already watching ' + L + '.'}, FADE_MS);
    if (e.phase === 'failed') return put(id, {project, warn: true, text: 'Couldn\'t add ' + L, sub: e.reason || ''}, FAIL_MS);
  });

  // routine bubbles fade after their life; paused on hover/focus and while the panel is open
  setInterval(() => {
    if (AA.state.open || !items.length) return;
    let changed = false;
    items.slice().forEach(it => {
      if (it.tone !== 'routine' || it.hover || it.focus || it.phase === 'sent') return;
      it.left -= TICK;
      if (it.left <= 0) { items = items.filter(i => i !== it); changed = true; }
    });
    if (changed) render();
  }, TICK);

  // the avatar and the docked browser move on their own; keep the stack beside the avatar
  setInterval(place, 250);

  AA.part('bb', {
    mount(){
      mount = document.getElementById('bb-mount');
      stack = document.createElement('div');
      stack.className = 'bb-stack bb-empty bb-side-r';
      mount.appendChild(stack);
      mount.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const it = itemOf(btn);
        if (it) act(btn, it);
      });
      mount.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('bb-input')) {
          const it = itemOf(e.target);
          if (it) send(it, e.target.closest('.bb-item'));
        }
      });
      AA.on('change', render);
      window.addEventListener('resize', place);
      render();
    },
    clear(){
      items = [];
      els.forEach(el => el.remove());
      els.clear();
      render();
    }
  });
})();
