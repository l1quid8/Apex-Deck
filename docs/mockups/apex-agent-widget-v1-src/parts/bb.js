/* bb: speech bubbles that pop out beside the avatar */
(function(){
  const ROUTINE_MS = 6000, TICK = 200, MAX_VISIBLE = 3;
  const SNOOZE_TEXT = "Okay — I'll bring it back at 3:40 PM.";
  const MOON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  let items = [];          // oldest -> newest
  const els = new Map();   // id -> wrapper element
  let mount = null, stack = null;

  const quietOn = () => !!(AA.state.quiet && AA.state.quiet.on);
  const quietTo = () => String((AA.state.quiet && AA.state.quiet.to) || '08:00').replace(/^0/, '');

  function inner(it, held){
    const e = AA.esc;
    const x = '<button class="bb-x" data-act="close" aria-label="Dismiss">×</button>';
    if (it.tone !== 'decision') {
      return '<div class="bb-row"><span class="bb-text">' + e(it.text) + '</span>' + x + '</div>' +
        (it.sub ? '<div class="bb-sub">' + e(it.sub) + '</div>' : '');
    }
    let h = '<div class="bb-row"><span class="bb-text">' + e(it.text) + '</span>' + x + '</div>';
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
    el.className = 'bb-item bb-' + it.tone;
    el.dataset.id = it.id;
    el.dataset.tone = it.tone;
    el.addEventListener('pointerenter', () => { it.hover = true; });
    el.addEventListener('pointerleave', () => { it.hover = false; });
    el.addEventListener('focusin', () => { it.focus = true; });
    el.addEventListener('focusout', e => { if (!el.contains(e.relatedTarget)) it.focus = false; });
    el.addEventListener('animationend', e => { if (e.target === el) el.classList.remove('bb-enter'); });
    return el;
  }

  // Position the stack beside the avatar (or the 6px edge tab when hidden).
  function place(){
    if (!stack || !mount) return;
    const st = AA.state;
    const H = mount.clientHeight;
    const side = st.pos.edge === 'left' ? 'left' : 'right';
    stack.style.left = ''; stack.style.right = ''; stack.style.top = '';
    stack.style[side] = (st.hidden ? 18 : 80) + 'px';   // 12px gap from avatar (68px from edge) or from the tab
    const vis = items.slice(-MAX_VISIBLE);
    if (st.open || !vis.length) return;
    const anchorY = st.pos.y + AA.AVATAR / 2;
    const h = stack.offsetHeight;
    let top = Math.max(8, Math.min(anchorY + 14 - h, H - 8 - h));
    stack.style.top = top + 'px';
    const newest = els.get(vis[vis.length - 1].id);
    const nh = newest ? newest.offsetHeight : 0;
    const tail = Math.max(h - nh + 14, Math.min(anchorY - top, h - 14));
    stack.style.setProperty('--bb-tail', tail + 'px');
  }

  function render(){
    if (!mount || !stack) return;
    const st = AA.state;
    const held = quietOn();
    const vis = items.slice(-MAX_VISIBLE);
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
        els.set(it.id, el);
        stack.appendChild(el);
        if (!isHeld) el.classList.add('bb-enter');   // held decisions appear without the pop
      }
      const sig = [it.phase, it.tone, it.text, it.sub || '', (it.evidence || []).join('|'), isHeld ? 1 : 0].join('\u0001');
      if (el.dataset.sig !== sig) { el.innerHTML = inner(it, isHeld); el.dataset.sig = sig; }
      el.classList.toggle('bb-decision', isDecision);
      el.classList.toggle('bb-routine', !isDecision);
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

  function send(it, el){
    const inp = el && el.querySelector('.bb-input');
    const text = inp ? inp.value.trim() : '';
    if (!text) { if (inp) inp.focus(); return; }
    AA.addMessage({from: 'me', kind: 'text', text});
    AA.emit('user-message', text);
    it.phase = 'sent';
    render();
    setTimeout(() => { if (items.includes(it)) removeItem(it.id); }, 1100);
  }

  function act(btn, it){
    const a = btn.dataset.act;
    if (a === 'close') return removeItem(it.id);
    if (a === 'chat') return AA.set({open: true, tab: 'chat'});
    if (a === 'snooze') { removeItem(it.id); return AA.bubble({id: 'snz', tone: 'routine', text: SNOOZE_TEXT}); }
    if (a === 'send') return send(it, btn.closest('.bb-item'));
  }

  const itemOf = target => {
    const el = target.closest && target.closest('.bb-item');
    return el ? items.find(i => i.id === el.dataset.id) : null;
  };

  AA.on('bubble', b => {
    if (!b || b.id == null) return;
    const id = String(b.id);
    const tone = b.tone === 'decision' ? 'decision' : 'routine';
    if (tone === 'routine' && quietOn()) return;   // quiet hours: routine stays silent
    const data = {tone, text: b.text || '', sub: b.sub || '', evidence: b.evidence || []};
    const found = items.find(i => i.id === id);
    if (found) {
      Object.assign(found, data, {phase: 'pending', left: ROUTINE_MS});
    } else {
      items = [...items, Object.assign({id, phase: 'pending', left: ROUTINE_MS, hover: false, focus: false}, data)];
    }
    render();
  });

  // routine bubbles fade after ROUTINE_MS; paused on hover/focus and while the panel is open
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
