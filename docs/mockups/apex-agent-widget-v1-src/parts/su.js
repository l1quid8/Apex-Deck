/* su: first-run setup inside the chat. Choices live in module variables so re-renders keep them. */
(function(){
  const DEFAULT_CHIPS = [
    {id:'f-launch', kind:'file', label:'docs/launch-plan.md', why:'mentions Nov 1 eight times', on:true},
    {id:'f-readme', kind:'file', label:'README.md', why:'project overview', on:true},
    {id:'f-test', kind:'file', label:'test-report.md', why:'SSO is failing, 3 of 12', on:true},
    {id:'t-release', kind:'thread', label:'Release thread', why:'you posted here 6 times this week', on:true},
    {id:'t-sso', kind:'thread', label:'SSO fixes', why:'linked from test-report.md', on:true},
    {id:'g-main', kind:'git', label:'main branch', why:'commits from the last 7 days', on:true}
  ];
  const POOL = [
    {id:'f-changelog', kind:'file', label:'CHANGELOG.md', why:'changed this week'},
    {id:'t-appstore', kind:'thread', label:'App Store copy', why:'you used this yesterday'},
    {id:'t-revert', kind:'thread', label:'Revert code', why:'talks about the build rollback'},
    {id:'f-privacy', kind:'file', label:'docs/privacy.md', why:'linked from the launch plan'}
  ];
  const GROUPS = [
    {kind:'file', title:'Files', note:''},
    {kind:'thread', title:'Chats', note:'you used these this week'},
    {kind:'git', title:'Git', note:'last 7 days'}
  ];
  const PROFILES = [
    {id:'luna', name:'GPT-6 Luna', note:'default'},
    {id:'sonnet', name:'Claude Sonnet', note:'deeper checks'},
    {id:'venice', name:'Venice Mini', note:'cheapest'}
  ];
  const ICONS = {
    file:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 1.75h5.2L12.5 5v9.25h-8.5z"/><path d="M6.5 9h3.5M6.5 11.5h3.5"/></svg>',
    thread:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 3.25h11v7h-6.2L4.5 13v-2.75h-2z"/></svg>',
    git:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 3-7 2.2-7 4.2"/></svg>'
  };
  const clone = x => JSON.parse(JSON.stringify(x));

  // module-level choices (survive re-renders)
  let chips = null;
  let goal = 'ship', goalText = '', goalOpen = false, goalDraft = '';
  let ints = [
    {id:'blockers', label:'Blockers', on:true},
    {id:'decisions', label:'Decisions', on:true},
    {id:'deadline', label:'Deadline at risk', on:true},
    {id:'every', label:'Every change', on:false}
  ];
  let profile = 'luna', profilesOpen = false;
  let searchOpen = false, searchQ = '';
  let flashId = null, flashTimer = null;
  let played = false;
  let host = null, focusSel = null;
  const bound = new WeakSet();

  function ensureChips(){
    if (!chips) chips = clone(AA.state.sources && AA.state.sources.length ? AA.state.sources : DEFAULT_CHIPS);
  }
  function projName(){
    const p = (AA.state.projects || []).find(x => x.id === AA.state.project);
    return p ? p.name : 'this project';
  }
  function avatarHtml(){
    const m = AA.parts.av && AA.parts.av.mini ? AA.parts.av.mini(20) : '<span class="su-dot"></span>';
    return `<span class="su-av">${m}</span>`;
  }
  function chipHtml(c){
    const flash = flashId === c.id ? ' su-flash' : '';
    return `<button type="button" class="su-chip ${c.on ? 'su-is-on' : 'su-is-off'}${flash}" data-act="toggle" data-id="${AA.esc(c.id)}" data-why="${AA.esc(c.why)}" aria-pressed="${c.on}" aria-label="${AA.esc(c.label)}, ${c.on ? 'watching, tap to stop' : 'not watching, tap to add back'}">`
      + `<span class="su-ic">${ICONS[c.kind] || ICONS.file}</span><span class="su-lbl">${AA.esc(c.label)}</span>`
      + `<span class="su-x" aria-hidden="true">${c.on ? '×' : '+'}</span></button>`;
  }
  function groupsHtml(){
    return GROUPS.map(g => {
      const list = chips.filter(c => (c.kind || 'file') === g.kind);
      if (!list.length) return '';
      return `<div class="su-group"><p class="su-glabel">${g.title}${g.note ? ' · <em>' + AA.esc(g.note) + '</em>' : ''}</p>`
        + `<div class="su-chips">${list.map(chipHtml).join('')}</div></div>`;
    }).join('');
  }
  function resultsHtml(){
    const q = searchQ.trim().toLowerCase();
    const list = POOL.filter(p => {
      const c = chips.find(x => x.label === p.label);
      return !(c && c.on) && (!q || p.label.toLowerCase().includes(q));
    });
    if (!list.length) return `<p class="su-none">${q ? 'Nothing else matches "' + AA.esc(searchQ.trim()) + '"' : 'Nothing else to add'}</p>`;
    return list.map(p => `<button type="button" class="su-res" data-act="pick" data-id="${AA.esc(p.id)}"><span class="su-ic">${ICONS[p.kind]}</span><span>${AA.esc(p.label)}</span><small>${AA.esc(p.why)}</small></button>`).join('');
  }
  function addHtml(){
    return `<div class="su-chips su-addrow" style="margin-top:8px"><button type="button" class="su-chip su-add" data-act="search" aria-expanded="${searchOpen}">+ Add</button></div>`
      + (searchOpen ? `<div class="su-search"><input class="su-q" type="search" placeholder="Search files and chats" aria-label="Search files and chats" value="${AA.esc(searchQ)}"><div class="su-results">${resultsHtml()}</div></div>` : '');
  }
  function pillHtml(act, id, label, sel){
    return `<button type="button" class="su-pill${sel ? ' su-is-sel' : ''}" data-act="${act}" data-id="${AA.esc(id)}" aria-pressed="${sel}">${sel ? '<span class="su-tick">✓</span>' : ''}${AA.esc(label)}</button>`;
  }
  function goalsHtml(){
    const goals = [
      {id:'ship', label:'Ship ' + projName() + ' by Nov 1'},
      {id:'tests', label:'Keep tests green'},
      {id:'morning', label:'Tell me what changed each morning'}
    ];
    let html = goals.map(g => pillHtml('goal', g.id, g.label, goal === g.id)).join('');
    if (goalOpen) {
      html += `<input class="su-goal-in" type="text" maxlength="80" placeholder="Type a goal" aria-label="Your goal" value="${AA.esc(goalDraft)}">`;
    } else if (goal === 'other' && goalText) {
      html += pillHtml('other', 'other', goalText, true);
    } else {
      html += `<button type="button" class="su-pill su-pill-other" data-act="other">Something else…</button>`;
    }
    return html;
  }
  function intsHtml(){
    return ints.map(i => pillHtml('int', i.id, i.label, i.on)).join('');
  }
  function footHtml(i){
    const p = PROFILES.find(x => x.id === profile) || PROFILES[0];
    const txt = profile === 'luna' ? `Uses your default model (${p.name})` : `Uses ${p.name}`;
    return `<div class="su-foot${played ? '' : ' su-enter'}" style="--i:${i}">`
      + `<button type="button" class="aa-btn aa-btn-primary su-go" data-act="go">Looks good — start watching</button>`
      + `<div class="su-model"><span>${txt} · </span><button type="button" class="su-link" data-act="profiles" aria-expanded="${profilesOpen}">change</button></div>`
      + (profilesOpen ? `<div class="su-profiles" role="radiogroup" aria-label="Model">${PROFILES.map(x => `<label class="su-prof"><input type="radio" name="su-profile" value="${x.id}"${x.id === profile ? ' checked' : ''}><span>${AA.esc(x.name)}</span><small>${AA.esc(x.note)}</small></label>`).join('')}</div>` : '')
      + `</div>`;
  }
  function msgHtml(i, inner){
    return `<div class="su-msg${played ? '' : ' su-enter'}" style="--i:${i}">${avatarHtml()}<div class="su-bub">${inner}</div></div>`;
  }

  function draw(el){
    if (!el) return;
    host = el;
    if (AA.state.setup !== 'proposing') { el.innerHTML = ''; return; }
    ensureChips();
    el.innerHTML = msgHtml(0, `<p>Hi — I'm Apex. I'll keep ${AA.esc(projName())} moving while you work, and only interrupt when something needs you.</p>`)
      + msgHtml(1, `<p>Here's what I'd watch. Tap to remove anything:</p>${groupsHtml()}${addHtml()}<p class="su-hint">or drag any file or chat onto me</p>`)
      + msgHtml(2, `<p>What should I keep on track?</p><div class="su-pills">${goalsHtml()}</div>`)
      + msgHtml(3, `<p>What should interrupt you?</p><div class="su-pills">${intsHtml()}</div>`)
      + footHtml(4);
    played = true;
    if (focusSel) {
      const f = el.querySelector(focusSel);
      if (f) f.focus();
      focusSel = null;
    }
  }

  function pick(id){
    const p = POOL.find(x => x.id === id);
    if (!p) return;
    const c = chips.find(x => x.label === p.label);
    if (c) c.on = true;
    else chips.push({id:p.id, kind:p.kind, label:p.label, why:p.why, on:true});
    searchOpen = false; searchQ = '';
  }
  function commitGoal(value){
    const v = String(value == null ? goalDraft : value).trim();
    if (v) { goal = 'other'; goalText = v; }
    goalOpen = false; goalDraft = '';
  }
  function finish(){
    const sources = chips.filter(c => c.on).map(c => ({id:c.id, kind:c.kind, label:c.label, why:c.why, on:true}));
    AA.set({setup:'done', sources, status:'watching'});
    AA.addMessage({from:'agent', kind:'text', text:"On it. I'll check when something changes and stay quiet otherwise. Next look: in about 20 min."});
  }

  function onClick(e){
    const t = e.target.closest('[data-act]');
    if (!t || !host || !host.contains(t)) return;
    const a = t.dataset.act, id = t.dataset.id;
    ensureChips();
    if (a === 'go') { finish(); return; }
    if (a === 'toggle') { const c = chips.find(x => x.id === id); if (c) c.on = !c.on; }
    else if (a === 'search') { searchOpen = !searchOpen; searchQ = ''; if (searchOpen) focusSel = '.su-q'; }
    else if (a === 'pick') { pick(id); }
    else if (a === 'goal') { goal = id; goalOpen = false; }
    else if (a === 'other') { goalOpen = true; goalDraft = goal === 'other' ? goalText : ''; focusSel = '.su-goal-in'; }
    else if (a === 'int') { const it = ints.find(x => x.id === id); if (it) it.on = !it.on; }
    else if (a === 'profiles') { profilesOpen = !profilesOpen; }
    else return;
    draw(host);
  }
  function onInput(e){
    const t = e.target;
    if (t.classList.contains('su-goal-in')) { goalDraft = t.value; return; }
    if (t.classList.contains('su-q')) {
      searchQ = t.value;
      const r = host && host.querySelector('.su-results');
      if (r) r.innerHTML = resultsHtml();
    }
  }
  function onKey(e){
    const t = e.target;
    if (t.classList.contains('su-goal-in')) {
      if (e.key === 'Enter') { e.preventDefault(); commitGoal(t.value); draw(host); }
      else if (e.key === 'Escape') { goalOpen = false; goalDraft = ''; draw(host); }
    } else if (t.classList.contains('su-q') && e.key === 'Enter') {
      e.preventDefault();
      const first = host.querySelector('.su-res');
      if (first) { pick(first.dataset.id); draw(host); }
    }
  }
  function onFocusOut(e){
    const t = e.target;
    if (t.classList && t.classList.contains('su-goal-in')) {
      // silent commit so a click elsewhere keeps the typed goal; the next draw shows it
      commitGoal(t.value);
    }
  }
  function onChange(e){
    const t = e.target;
    if (t.name === 'su-profile') { profile = t.value; profilesOpen = false; draw(host); }
  }

  function bind(el){
    if (bound.has(el)) return;
    bound.add(el);
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('change', onChange);
  }

  function render(el){
    if (!el) return;
    host = el;
    bind(el);
    draw(el);
  }

  AA.on('source-dropped', obj => {
    if (!obj || !obj.label) return;
    const kind = obj.kind || 'file';
    const S = AA.state;
    if (S.setup === 'proposing') {
      ensureChips();
      let c = chips.find(x => x.label === obj.label);
      if (!c) {
        c = {id:'d-' + Math.random().toString(36).slice(2, 7), kind, label:obj.label, why:obj.why || 'you dropped it on me', on:true};
        chips.push(c);
      }
      c.on = true;
      flashId = c.id;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashId = null; if (host && host.isConnected) draw(host); }, 1800);
      if (host && host.isConnected) draw(host);
    } else if (S.setup === 'done') {
      const list = S.sources || [];
      const why = obj.why || 'you dropped it on me';
      const id = 'd-' + Math.random().toString(36).slice(2, 7);
      AA.set({sources:[...list, {id, kind, label:obj.label, why, on:true}]});
      AA.addMessage({from:'agent', kind:'note', text:'Added ' + obj.label + ' to what I watch.'});
    }
  });

  AA.part('su', {mount(){}, render});
})();
