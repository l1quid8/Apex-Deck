/* su: first-run setup inside the chat. Suggestions and choices are kept per project id. */
(function(){
  // Suggestions per project. Each source: {id, kind:'file'|'thread'|'git', ref, label, why, on}.
  const SUGGEST = {
    mobile: {
      goal: 'Keep the Nov 1 launch on track',
      list: [
        {id:'m-launch', kind:'file', ref:'docs/launch-plan.md', label:'docs/launch-plan.md', why:'mentions Nov 1 eight times', on:true},
        {id:'m-test', kind:'file', ref:'test-report.md', label:'test-report.md', why:'SSO is failing, 3 of 12', on:true},
        {id:'m-release', kind:'thread', ref:'thread:release', label:'Release thread', why:'you posted here 6 times this week', on:true},
        {id:'m-sso', kind:'thread', ref:'thread:sso-fixes', label:'SSO fixes', why:'linked from test-report.md', on:true},
        {id:'m-git', kind:'git', ref:'main', label:'main branch', why:'commits from the last 7 days', on:true}
      ],
      pool: [
        {id:'m-privacy', kind:'file', ref:'docs/privacy.md', label:'docs/privacy.md', why:'linked from the launch plan', on:true},
        {id:'m-appstore', kind:'thread', ref:'thread:app-store-copy', label:'App Store copy', why:'you used this yesterday', on:true}
      ]
    },
    deck: {
      goal: 'Keep ApexAgent on track to merge',
      list: [
        {id:'d-plan', kind:'file', ref:'docs/plans/agents-assistant-scheduling.md', label:'docs/plans/agents-assistant-scheduling.md', why:"the plan you're building", on:true},
        {id:'d-deploy', kind:'thread', ref:'thread:deploy-checklist', label:'Deploy checklist', why:'you posted here this week', on:true},
        {id:'d-git', kind:'git', ref:'main', label:'main branch', why:'commits from the last 7 days', on:true},
        {id:'d-changelog', kind:'file', ref:'CHANGELOG.md', label:'CHANGELOG.md', why:'changed this week', on:true}
      ],
      pool: [
        {id:'d-readme', kind:'file', ref:'README.md', label:'README.md', why:'project overview', on:true},
        {id:'d-revert', kind:'thread', ref:'thread:revert-code', label:'Revert code', why:'talks about the build rollback', on:true}
      ]
    }
  };
  const FALLBACK = {goal:'Keep this project on track', list:[], pool:[]};
  const GROUPS = [
    {kind:'file', title:'Files', note:''},
    {kind:'thread', title:'Chats', note:'you used these this week'},
    {kind:'git', title:'Git', note:'last 7 days'}
  ];
  const INTS = [
    {id:'blockers', label:'Blockers', on:true},
    {id:'decisions', label:'Decisions', on:true},
    {id:'deadline', label:'Deadline at risk', on:true},
    {id:'every', label:'Every change', on:false}
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
  const srcKey = x => x.kind + ':' + x.ref;

  // Draft choices, one per project id. Re-renders for the same project keep the edits.
  const drafts = {};
  let host = null, focusSel = null, flashTimer = null, played = false;
  const bound = new WeakSet();

  function draft(){
    const pid = AA.state.project;
    if (!drafts[pid]) {
      const sug = SUGGEST[pid] || FALLBACK;
      drafts[pid] = {
        chips: clone(sug.list), removed: [], pool: clone(sug.pool), goal: 'g1', goalText: '',
        goalOpen: false, goalDraft: '', ints: clone(INTS), profile: 'luna', profilesOpen: false,
        searchOpen: false, searchQ: '', flashId: null
      };
    }
    return drafts[pid];
  }
  function projInfo(){
    const p = (AA.state.projects || []).find(x => x.id === AA.state.project);
    return {name: p ? p.name : 'this project', machine: p ? p.machine : 'this machine'};
  }
  function avatarHtml(){
    const m = AA.parts.av && AA.parts.av.mini ? AA.parts.av.mini(20) : '<span class="su-dot"></span>';
    return `<span class="su-av">${m}</span>`;
  }
  function chipHtml(d, c){
    const flash = d.flashId === c.id ? ' su-flash' : '';
    return `<span class="su-chip${flash}"><span class="su-ic">${ICONS[c.kind] || ICONS.file}</span>`
      + `<span class="su-txt"><span class="su-lbl">${AA.esc(c.label)}</span><span class="su-why">${AA.esc(c.why)}</span></span>`
      + `<button type="button" class="su-x" data-act="remove" data-id="${AA.esc(c.id)}" aria-label="${AA.esc("Don't watch " + c.label)}">×</button></span>`;
  }
  function groupsHtml(d){
    return GROUPS.map(g => {
      const list = d.chips.filter(c => c.kind === g.kind);
      if (!list.length) return '';
      return `<div class="su-group"><p class="su-glabel">${g.title}${g.note ? ' · <em>' + AA.esc(g.note) + '</em>' : ''}</p>`
        + `<div class="su-chips">${list.map(c => chipHtml(d, c)).join('')}</div></div>`;
    }).join('');
  }
  function candidates(d){ // removed suggestions first, then this project's extra pool
    const seen = new Set(d.chips.map(srcKey));
    return d.removed.concat(d.pool).filter(x => { if (seen.has(srcKey(x))) return false; seen.add(srcKey(x)); return true; });
  }
  function resultsHtml(d){
    const q = d.searchQ.trim().toLowerCase();
    const list = candidates(d).filter(p => !q || p.label.toLowerCase().includes(q));
    if (!list.length) return `<p class="su-none">${q ? 'Nothing else matches "' + AA.esc(d.searchQ.trim()) + '"' : 'Nothing else to add'}</p>`;
    return list.map(p => `<button type="button" class="su-res" data-act="pick" data-id="${AA.esc(p.id)}"><span class="su-ic">${ICONS[p.kind] || ICONS.file}</span><span class="su-rl">${AA.esc(p.label)}</span><small>${AA.esc(p.why)}</small></button>`).join('');
  }
  function addHtml(d){
    return `<div class="su-chips su-addrow" style="margin-top:8px"><button type="button" class="su-chip su-add" data-act="search" aria-expanded="${d.searchOpen}">+ Add</button></div>`
      + (d.searchOpen ? `<div class="su-search"><input class="su-q" type="search" placeholder="Search files and chats" aria-label="Search files and chats" value="${AA.esc(d.searchQ)}"><div class="su-results">${resultsHtml(d)}</div></div>` : '');
  }
  function pillHtml(act, id, label, sel){
    return `<button type="button" class="su-pill${sel ? ' su-is-sel' : ''}" data-act="${act}" data-id="${AA.esc(id)}" aria-pressed="${sel}">${sel ? '<span class="su-tick">✓</span>' : ''}${AA.esc(label)}</button>`;
  }
  function goalsHtml(d){
    const goals = [
      {id:'g1', label: (SUGGEST[AA.state.project] || FALLBACK).goal},
      {id:'tests', label:'Keep tests green'},
      {id:'morning', label:'Tell me what changed each morning'}
    ];
    let html = goals.map(g => pillHtml('goal', g.id, g.label, d.goal === g.id)).join('');
    if (d.goalOpen) {
      html += `<input class="su-goal-in" type="text" maxlength="80" placeholder="Type a goal" aria-label="Your goal" value="${AA.esc(d.goalDraft)}">`;
    } else if (d.goal === 'other' && d.goalText) {
      html += pillHtml('other', 'other', d.goalText, true);
    } else {
      html += `<button type="button" class="su-pill su-pill-other" data-act="other">Something else</button>`;
    }
    return html;
  }
  function intsHtml(d){
    return d.ints.map(i => pillHtml('int', i.id, i.label, i.on)).join('');
  }
  function footHtml(d, i){
    const p = PROFILES.find(x => x.id === d.profile) || PROFILES[0];
    const txt = d.profile === 'luna' ? `Uses your default model (${p.name})` : `Uses ${p.name}`;
    return `<div class="su-foot${played ? '' : ' su-enter'}" style="--i:${i}">`
      + `<button type="button" class="aa-btn aa-btn-primary su-go" data-act="go">Looks good — start watching</button>`
      + `<div class="su-model"><span>${txt} · </span><button type="button" class="su-link" data-act="profiles" aria-expanded="${d.profilesOpen}">change</button></div>`
      + (d.profilesOpen ? `<div class="su-profiles" role="radiogroup" aria-label="Model">${PROFILES.map(x => `<label class="su-prof"><input type="radio" name="su-profile" value="${x.id}"${x.id === d.profile ? ' checked' : ''}><span>${AA.esc(x.name)}</span><small>${AA.esc(x.note)}</small></label>`).join('')}</div>` : '')
      + `</div>`;
  }
  function msgHtml(i, inner){
    return `<div class="su-msg${played ? '' : ' su-enter'}" style="--i:${i}">${avatarHtml()}<div class="su-bub">${inner}</div></div>`;
  }

  function draw(el){
    if (!el) return;
    host = el;
    if (AA.state.setup !== 'proposing') { el.innerHTML = ''; return; }
    const d = draft(), p = projInfo();
    el.innerHTML = msgHtml(0, `<p>Hi — I'm Apex. I'll keep ${AA.esc(p.name)} moving while you work, and only interrupt when something needs you.</p>`)
      + msgHtml(1, `<p>Here's what I'll watch in ${AA.esc(p.name)} (on ${AA.esc(p.machine)}). OK?</p>${groupsHtml(d)}${addHtml(d)}<p class="su-hint">Tip: drag a file or chat onto me to add it later.</p>`)
      + msgHtml(2, `<p>What should I keep on track?</p><div class="su-pills">${goalsHtml(d)}</div>`)
      + msgHtml(3, `<p>What should interrupt you?</p><div class="su-pills">${intsHtml(d)}</div>`)
      + footHtml(d, 4);
    played = true;
    if (focusSel) {
      const f = el.querySelector(focusSel);
      if (f) f.focus();
      focusSel = null;
    }
  }

  function pick(d, id){
    const p = candidates(d).find(x => x.id === id);
    if (!p) return;
    d.removed = d.removed.filter(x => srcKey(x) !== srcKey(p));
    d.chips.push({id:p.id, kind:p.kind, ref:p.ref, label:p.label, why:p.why, on:true});
    d.searchOpen = false; d.searchQ = '';
  }
  function remove(d, id){
    const c = d.chips.find(x => x.id === id);
    if (!c) return;
    d.chips = d.chips.filter(x => x !== c);
    d.removed = d.removed.filter(x => srcKey(x) !== srcKey(c)).concat([c]);
  }
  function commitGoal(d, value){
    const v = String(value == null ? d.goalDraft : value).trim();
    if (v) { d.goal = 'other'; d.goalText = v; }
    d.goalOpen = false; d.goalDraft = '';
  }
  function finish(){
    const d = draft(), p = projInfo();
    const sources = d.chips.map(c => ({id:c.id, kind:c.kind, ref:c.ref, label:c.label, why:c.why, on:true}));
    AA.set({setup:'done', status:'watching', sources});
    const n = sources.length;
    AA.addMessage({from:'agent', kind:'text', text:`On it. Watching ${n} source${n === 1 ? '' : 's'} in ${p.name} on ${p.machine}. I'll stay quiet unless something changes.`});
  }

  function onClick(e){
    const t = e.target.closest('[data-act]');
    if (!t || !host || !host.contains(t)) return;
    const a = t.dataset.act, id = t.dataset.id;
    const d = draft();
    if (a === 'go') { finish(); return; }
    if (a === 'remove') remove(d, id);
    else if (a === 'search') { d.searchOpen = !d.searchOpen; d.searchQ = ''; if (d.searchOpen) focusSel = '.su-q'; }
    else if (a === 'pick') pick(d, id);
    else if (a === 'goal') { d.goal = id; d.goalOpen = false; }
    else if (a === 'other') { d.goalOpen = true; d.goalDraft = d.goal === 'other' ? d.goalText : ''; focusSel = '.su-goal-in'; }
    else if (a === 'int') { const it = d.ints.find(x => x.id === id); if (it) it.on = !it.on; }
    else if (a === 'profiles') { d.profilesOpen = !d.profilesOpen; }
    else return;
    draw(host);
  }
  function onInput(e){
    const t = e.target, d = draft();
    if (t.classList.contains('su-goal-in')) { d.goalDraft = t.value; return; }
    if (t.classList.contains('su-q')) {
      d.searchQ = t.value;
      const r = host && host.querySelector('.su-results');
      if (r) r.innerHTML = resultsHtml(d);
    }
  }
  function onKey(e){
    const t = e.target, d = draft();
    if (t.classList.contains('su-goal-in')) {
      if (e.key === 'Enter') { e.preventDefault(); commitGoal(d, t.value); draw(host); }
      else if (e.key === 'Escape') { d.goalOpen = false; d.goalDraft = ''; draw(host); }
    } else if (t.classList.contains('su-q') && e.key === 'Enter') {
      e.preventDefault();
      const first = host.querySelector('.su-res');
      if (first) { pick(d, first.dataset.id); draw(host); }
    }
  }
  function onFocusOut(e){
    const t = e.target;
    // silent commit so a click elsewhere keeps the typed goal
    if (t.classList && t.classList.contains('su-goal-in')) commitGoal(draft(), t.value);
  }
  function onChange(e){
    const t = e.target;
    if (t.name === 'su-profile') { const d = draft(); d.profile = t.value; d.profilesOpen = false; draw(host); }
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

  // A drop that finished (core emits 'added' only after the file checks pass) while the proposal is open.
  AA.on('source-add', ev => {
    if (!ev || ev.phase !== 'added' || AA.state.setup !== 'proposing' || (ev.project && ev.project !== AA.state.project)) return;
    const d = draft(), kind = ev.kind || 'file';
    let c = d.chips.find(x => x.label === ev.label);
    if (!c) {
      c = {id:'d-' + Math.random().toString(36).slice(2, 7), kind, ref:ev.label, label:ev.label, why:'you dropped it here', on:true};
      d.chips.push(c);
    }
    d.flashId = c.id;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { d.flashId = null; if (host && host.isConnected) draw(host); }, 1800);
    if (host && host.isConnected) draw(host);
  });

  AA.part('su', {mount(){}, render});
})();
