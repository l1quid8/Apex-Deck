(function(){
  'use strict';
  const ICON = {
    expand:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5l4.5-4.5"/></svg>',
    collapse:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5v4h4M13.5 2.5l-4 4M6.5 13.5v-4h-4M2.5 13.5l4-4"/></svg>',
    close:'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>'
  };
  const SUGGESTIONS = ['What needs me?', 'What changed today?', 'Check now'];
  let frame, head, tabsEl, view, composer, ctxEl, suggEl, ta;
  let lastTab = null, lastOpen = false, lastCount = 0;

  const E = s => AA.esc(s);
  const st = () => AA.state;

  function av(size){
    try { if (AA.parts.av && typeof AA.parts.av.mini === 'function') return AA.parts.av.mini(size); }
    catch (err) { console.error('[cv] av.mini', err); }
    return '<span class="cv-ph" style="width:'+size+'px;height:'+size+'px"></span>';
  }
  function projectOf(s){
    const list = s.projects || [];
    return list.find(p => p.id === s.project) || list[0] || {name:'No project', machine:'This Mac'};
  }
  function sourceCount(s){ return (s.sources || []).filter(x => x.on).length || 6; }
  function statusLine(s, proj){
    const n = s.needs || 0;
    switch (s.status) {
      case 'new': return 'Getting set up';
      case 'watching': return 'Watching · checked ' + (s.checkedAgo || '4m ago');
      case 'checking': return 'Checking now…';
      case 'needs': return 'Needs you' + (n ? ' · ' + n + ' decision' + (n === 1 ? '' : 's') : '');
      case 'paused': return 'Paused';
      case 'offline': return 'Offline — ' + (proj.machine || 'This Mac') + ' is asleep';
      default: return 'Watching';
    }
  }
  function mockNote(parent){
    if (!parent || parent.querySelector('.cv-mock')) return;
    const n = document.createElement('span');
    n.className = 'cv-mock';
    n.textContent = '(mockup)';
    parent.appendChild(n);
  }

  function positionFrame(){
    const s = st(), r = AA.panelRect(), pos = s.pos || {edge:'right', y:420};
    frame.style.left = r.left + 'px';
    frame.style.top = r.top + 'px';
    frame.style.width = r.width + 'px';
    frame.style.height = r.height + 'px';
    const ay = Math.max(0, Math.min(100, ((pos.y + AA.AVATAR / 2 - r.top) / r.height) * 100));
    frame.style.transformOrigin = (pos.edge === 'left' ? '0%' : '100%') + ' ' + ay.toFixed(1) + '%';
    frame.dataset.edge = pos.edge === 'left' ? 'left' : 'right';
    frame.classList.toggle('cv-is-open', !!s.open);
    frame.setAttribute('aria-hidden', s.open ? 'false' : 'true');
  }

  function renderHead(){
    const s = st(), proj = projectOf(s), tall = s.size === 'tall';
    head.innerHTML =
      '<div class="cv-id"><span class="cv-avwrap">' + av(28) + '</span><div class="cv-idtxt">' +
        '<div class="cv-name">Apex</div>' +
        '<div class="cv-status"><i class="cv-dot cv-d-' + E(s.status) + '"></i><span>' + E(statusLine(s, proj)) + '</span></div>' +
      '</div></div>' +
      '<button class="cv-proj" data-cv-act="switch" aria-expanded="' + (!!s.switcher) + '" title="Switch project">' + E(proj.name) + ' <span class="cv-caret">▾</span></button>' +
      '<div class="cv-icons">' +
        '<button class="cv-ib" data-cv-act="size" title="' + (tall ? 'Make smaller' : 'Make taller') + '" aria-label="' + (tall ? 'Collapse' : 'Expand') + '">' + (tall ? ICON.collapse : ICON.expand) + '</button>' +
        '<button class="cv-ib" data-cv-act="close" title="Close (Esc)" aria-label="Close">' + ICON.close + '</button>' +
      '</div>';
  }

  function renderSwitcher(){
    let pop = frame.querySelector('.cv-switcher-pop');
    if (!st().switcher) { if (pop) pop.remove(); return; }
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'cv-switcher-pop';
      frame.appendChild(pop);
    }
    pop.innerHTML = '';
    const cf = AA.parts.cf;
    if (cf && typeof cf.renderSwitcher === 'function') {
      try { cf.renderSwitcher(pop); } catch (err) { console.error('[cv] cf.renderSwitcher', err); }
    } else {
      pop.innerHTML = (st().projects || []).map(p =>
        '<button class="cv-pick" data-cv-act="pick" data-id="' + E(p.id) + '"><span>' + E(p.name) + '</span><small>' + E(p.machine) + '</small></button>'
      ).join('');
    }
  }

  function renderTabs(){
    const s = st();
    const defs = [['chat', 'Chat'], ['activity', 'Activity'], ['settings', '⚙']];
    tabsEl.innerHTML = defs.map(([k, label]) => {
      const on = s.tab === k;
      const count = (k === 'activity' && s.needs > 0) ? ' <span class="cv-count">' + s.needs + '</span>' : '';
      const aria = k === 'settings' ? ' aria-label="Settings" title="Settings"' : '';
      return '<button role="tab" class="cv-tab' + (on ? ' cv-is-on' : '') + '" data-cv-act="tab" data-tab="' + k + '" aria-selected="' + on + '"' + aria + '>' + label + count + '</button>';
    }).join('');
  }

  function agentAvatar(){ return '<span class="cv-ava">' + av(20) + '</span>'; }

  function renderMsg(m){
    if (m.kind === 'setup') return '';
    if (m.kind === 'check') return '<div class="cv-check">' + E(m.text) + '</div>';
    if (m.from === 'me') return '<div class="cv-me"><div class="cv-bub">' + E(m.text) + '</div></div>';
    if (m.kind === 'blocker') return blockerHTML(m);
    if (m.kind === 'draft') return draftHTML(m);
    if (m.kind === 'note') {
      return '<div class="cv-note"><span class="cv-chip cv-chip-note">Remembered</span><span>' + E(m.text) + '</span></div>';
    }
    return '<div class="cv-agent">' + agentAvatar() + '<div class="cv-agent-body"><div class="cv-txt">' + E(m.text) + '</div>' +
      (m.time ? '<span class="cv-time">' + E(m.time) + '</span>' : '') + '</div></div>';
  }

  function blockerHTML(m){
    const status = m.status || 'open';
    const done = status === 'resolved';
    const snoozed = status === 'snoozed';
    const cls = 'cv-blk' + (done ? ' cv-is-done' : '') + (snoozed ? ' cv-is-snoozed' : '');
    const lines =
      (m.observed ? '<div class="cv-line"><span class="cv-lbl">Observed</span><span>' + E(m.observed) + '</span></div>' : '') +
      (m.inference ? '<div class="cv-line"><span class="cv-lbl">My read</span><span>' + E(m.inference) + '</span></div>' : '');
    const evidence = (m.evidence || []).map((ev, i) => {
      const chip = ev.line != null && ev.line !== '' ? ev.label + ':' + ev.line : ev.label;
      return '<div class="cv-ev"><button class="cv-src" data-cv-act="src" data-id="' + E(m.id) + '" data-index="' + i + '" title="Open source">' + E(chip) + '</button>' +
        (ev.quote ? '<pre class="cv-quote">' + E(ev.quote) + '</pre>' : '') + '</div>';
    }).join('');
    let foot = '';
    if (status === 'open') {
      foot = '<div class="cv-acts">' +
        '<button class="aa-btn aa-btn-primary cv-btn" data-cv-act="resolve" data-id="' + E(m.id) + '">Resolve</button>' +
        '<button class="aa-btn cv-btn" data-cv-act="snooze" data-id="' + E(m.id) + '">Snooze 1 day</button>' +
        '<button class="aa-btn aa-btn-ghost cv-btn" data-cv-act="notblocker" data-id="' + E(m.id) + '">Not a blocker</button>' +
      '</div>';
    } else if (done) {
      foot = '<div class="cv-done">✓ ' + (m.by === 'not' ? 'Marked not a blocker by you' : 'Resolved by you') + '</div>';
    } else if (snoozed) {
      foot = '<div class="cv-done cv-muted">Snoozed · back tomorrow</div>';
    }
    return '<div class="cv-agent">' + agentAvatar() + '<div class="' + cls + '">' +
      '<div class="cv-blk-head"><span class="cv-chip cv-chip-amber">Blocker</span>' +
        (m.time ? '<span class="cv-time">' + E(m.time) + '</span>' : '') + '</div>' +
      '<div class="cv-txt">' + E(m.text) + '</div>' + lines + evidence + foot +
    '</div></div>';
  }

  function draftHTML(m){
    return '<div class="cv-agent">' + agentAvatar() + '<div class="cv-doc">' +
      '<div class="cv-doc-head"><span class="cv-chip cv-chip-draft">Draft</span><b>' + E(m.title || 'Untitled') + '</b></div>' +
      '<div class="cv-doc-body">' + E(m.text || '') + '</div>' +
      '<div class="cv-doc-acts">' +
        '<button class="aa-btn cv-btn" data-cv-act="mock">Open as file</button>' +
        '<button class="aa-btn cv-btn" data-cv-act="mock">Edit in chat</button>' +
      '</div></div></div>';
  }

  function buildChat(el){
    const s = st();
    const wrap = document.createElement('div');
    wrap.className = 'cv-chat';
    el.appendChild(wrap);
    if (s.setup === 'proposing' && AA.parts.su && typeof AA.parts.su.render === 'function') {
      const slot = document.createElement('div');
      slot.className = 'cv-setup';
      wrap.appendChild(slot);
      try { AA.parts.su.render(slot); } catch (err) { console.error('[cv] su.render', err); }
    }
    const msgs = s.messages || [];
    if (!msgs.length && s.setup !== 'proposing') {
      wrap.insertAdjacentHTML('beforeend', '<p class="cv-empty">Nothing yet. Ask me anything, or let me keep watching.</p>');
    }
    wrap.insertAdjacentHTML('beforeend', msgs.map(renderMsg).join(''));
    if (s.status === 'checking') {
      wrap.insertAdjacentHTML('beforeend',
        '<div class="cv-typing"><span class="cv-dots"><i></i><i></i><i></i></span><span>Apex is checking ' + sourceCount(s) + ' sources…</span></div>');
    }
  }

  function buildPart(el, name, fn, fallback){
    const p = AA.parts[name];
    if (p && typeof p[fn] === 'function') {
      try { p[fn](el); return; } catch (err) { console.error('[cv] ' + name + '.' + fn, err); }
    }
    el.innerHTML = '<p class="cv-empty">' + E(fallback) + '</p>';
  }

  function renderView(){
    const s = st(), tab = s.tab || 'chat';
    const prevTop = view.scrollTop;
    const wasBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    const tabChanged = tab !== lastTab;
    const openedNow = !!s.open && !lastOpen;
    const newMsgs = (s.messages || []).length > lastCount;

    view.innerHTML = '';
    const pane = document.createElement('div');
    pane.className = 'cv-pane';
    view.appendChild(pane);
    if (tab === 'chat') buildChat(pane);
    else if (tab === 'activity') buildPart(pane, 'cf', 'renderActivity', 'Activity shows up here.');
    else buildPart(pane, 'cf', 'renderSettings', 'Settings are coming soon.');

    if (tab === 'chat') {
      // First-run setup reads top-down, so start it at the intro instead of the bottom.
      if (s.setup === 'proposing' && !newMsgs) view.scrollTop = (tabChanged || openedNow) ? 0 : prevTop;
      else view.scrollTop = (tabChanged || openedNow || wasBottom || newMsgs) ? view.scrollHeight : prevTop;
    } else {
      view.scrollTop = tabChanged ? 0 : prevTop;
    }
    lastTab = tab;
    lastOpen = !!s.open;
    lastCount = (s.messages || []).length;
  }

  function renderComposer(){
    const s = st(), chat = (s.tab || 'chat') === 'chat';
    composer.hidden = !chat;
    const ctxLabel = s.context && s.context.label;
    ctxEl.innerHTML = ctxLabel
      ? '<span class="cv-ctx-chip">Looking at: <b>' + E(ctxLabel) + '</b><button class="cv-x" data-cv-act="dropctx" aria-label="Stop looking at this" title="Stop looking at this">×</button></span>'
      : '';
    const msgs = s.messages || [];
    const last = msgs[msgs.length - 1];
    const showSugg = chat && (!msgs.length || (last && last.from === 'agent'));
    suggEl.innerHTML = showSugg
      ? SUGGESTIONS.map(t => '<button class="cv-sg" data-cv-act="sugg" data-text="' + E(t) + '">' + E(t) + '</button>').join('')
      : '';
  }

  function grow(){
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  }

  function sendText(text){
    text = (text || '').trim();
    if (!text) return;
    AA.addMessage({from:'me', kind:'text', text});
    AA.emit('user-message', text);
  }
  function sendFromBox(){
    const v = ta.value;
    ta.value = '';
    grow();
    sendText(v);
    ta.focus();
  }

  function decide(id, how){
    const s = st();
    const target = (s.messages || []).find(m => m.id === id);
    if (!target) return;
    const wasOpen = !target.status || target.status === 'open';
    const messages = s.messages.map(m => m.id === id
      ? {...m, status: how === 'snooze' ? 'snoozed' : 'resolved', by: how}
      : m);
    const needs = wasOpen ? Math.max(0, (s.needs || 0) - 1) : (s.needs || 0);
    const patch = {messages, needs};
    if (needs === 0 && s.status === 'needs') patch.status = 'watching';
    AA.set(patch);
  }

  function onClick(e){
    const t = e.target.closest && e.target.closest('[data-cv-act]');
    if (!t || !frame.contains(t)) return;
    const s = st(), act = t.dataset.cvAct, id = t.dataset.id;
    switch (act) {
      case 'close': AA.set({open:false, switcher:false}); break;
      case 'size': AA.set({size: s.size === 'tall' ? 'compact' : 'tall'}); break;
      case 'switch': AA.set({switcher: !s.switcher}); break;
      case 'pick': AA.set({project: id, switcher:false}); break;
      case 'tab': AA.set({tab: t.dataset.tab}); break;
      case 'send': sendFromBox(); break;
      case 'sugg': sendText(t.dataset.text); break;
      case 'dropctx': AA.set({context:null}); break;
      case 'resolve': decide(id, 'resolve'); break;
      case 'snooze': decide(id, 'snooze'); break;
      case 'notblocker': decide(id, 'not'); break;
      case 'mock': mockNote(t.parentElement); break;
      case 'src':
        AA.emit('open-source', {id, index: +t.dataset.index});
        mockNote(t.parentElement);
        break;
    }
  }

  function onKey(e){
    if (e.key !== 'Escape' || !st().open) return;
    if (st().switcher) AA.set({switcher:false});
    else AA.set({open:false});
  }

  function onTaKey(e){
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFromBox();
    }
  }

  function render(){
    if (!frame) return;
    positionFrame();
    renderHead();
    renderSwitcher();
    renderTabs();
    renderView();
    renderComposer();
  }

  function mount(){
    const host = document.getElementById('cv-mount');
    if (!host) return;
    frame = document.createElement('div');
    frame.className = 'cv-frame';
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-label', 'Apex conversation');
    frame.innerHTML =
      '<header class="cv-head"></header>' +
      '<nav class="cv-tabs" role="tablist"></nav>' +
      '<div class="cv-view"></div>' +
      '<div class="cv-composer">' +
        '<div class="cv-ctx"></div>' +
        '<div class="cv-sugg"></div>' +
        '<div class="cv-inrow">' +
          '<textarea class="cv-ta" rows="1" placeholder="Message Apex… (it keeps working while you talk)" aria-label="Message Apex"></textarea>' +
          '<button class="cv-mic" disabled title="Voice — later" aria-label="Voice, later"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg></button>' +
          '<button class="cv-send" data-cv-act="send" aria-label="Send">↑</button>' +
        '</div>' +
      '</div>';
    host.appendChild(frame);
    head = frame.querySelector('.cv-head');
    tabsEl = frame.querySelector('.cv-tabs');
    view = frame.querySelector('.cv-view');
    composer = frame.querySelector('.cv-composer');
    ctxEl = frame.querySelector('.cv-ctx');
    suggEl = frame.querySelector('.cv-sugg');
    ta = frame.querySelector('.cv-ta');

    frame.addEventListener('click', onClick);
    ta.addEventListener('keydown', onTaKey);
    ta.addEventListener('input', grow);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', positionFrame);
    AA.on('change', render);
    render();
  }

  AA.part('cv', {mount});
})();
