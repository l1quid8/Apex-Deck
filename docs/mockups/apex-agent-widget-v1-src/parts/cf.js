(function(){
  const AA = window.AA;
  const esc = s => AA.esc(s);
  const svg = (d, w) => `<svg width="${w||14}" height="${w||14}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    tick: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>'),
    doc: svg('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M9.5 13h5M9.5 17h5"/>'),
    arrow: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
    git: svg('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-12 2-12 6"/>'),
    more: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    x: svg('<path d="M6 6l12 12M18 6 6 18"/>', 12),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 16)
  };
  const KIND_ICON = {file: ICON.doc, thread: ICON.chat, git: ICON.git};
  const DEFAULT_SOURCES = [
    {id:'src-launch', kind:'file', label:'docs/launch-plan.md'},
    {id:'src-tests', kind:'file', label:'test-report.md'},
    {id:'src-changelog', kind:'file', label:'CHANGELOG.md'},
    {id:'src-release', kind:'thread', label:'Release thread'},
    {id:'src-sso', kind:'thread', label:'SSO fixes'},
    {id:'src-git', kind:'git', label:'git · main'}
  ];
  const SEED_CHECKS = [
    {label:'9:14 · 6 sources · nothing new', icon:'tick'},
    {label:'8:51 · test-report.md changed · 1 blocker', icon:'doc'},
    {label:'8:02 · redirected by you', icon:'arrow'},
    {label:'7:30 · 6 sources · nothing new', icon:'tick'},
    {label:'Yesterday · launch-plan.md changed · 1 decision', icon:'doc'}
  ];
  const MODELS = ['GPT-6 Luna', 'Claude Sonnet', 'Claude Opus'];
  const DEFAULT_RULES = {blockers:true, decisions:true, deadline:true, every:false};
  const RULE_ROWS = [
    ['blockers', 'Blockers', 'Apex is stuck and needs a choice from you'],
    ['decisions', 'Decisions', 'Apex has a choice ready for you to approve'],
    ['deadline', 'Deadline at risk', 'A date you set is slipping'],
    ['every', 'Every change', 'A ping for each file or thread change']
  ];
  const ROUTINE = [['panel','In the panel'], ['bubble','Bubble'], ['bubble+phone','Bubble + iPhone']];
  const DECISION = [['bubble+phone','Bubble + iPhone'], ['bubble','Bubble'], ['panel','In the panel']];

  // UI-only state. el is re-rendered on every change, so this lives here.
  const ui = {
    menu: null,
    schedItems: [{id:'sch-1', label:'Weekdays 9:00 · morning summary', paused:false}],
    memories: [
      {id:'m1', text:'SSO deferred past Nov 1 — you, Oct 9'},
      {id:'m2', text:'You prefer drafts before anything is sent'},
      {id:'m3', text:'Launch date: Nov 1'}
    ],
    moreNotes: false,
    modelOpen: false,
    model: 'GPT-6 Luna',
    confirmStop: false,
    seeded: false
  };
  let schedSeq = 2;

  function proj(){
    const s = AA.state;
    return s.projects.find(p => p.id === s.project) || s.projects[0] || {id:'none', name:'Apex', machine:'', status:'watching', needs:0};
  }
  function ensureSources(){
    if (!AA.state.sources.length && !ui.seeded){
      ui.seeded = true;
      AA.state.sources = DEFAULT_SOURCES.map(x => ({...x, on:true}));
    }
  }
  function togglePause(){
    AA.set({status: AA.state.status === 'paused' ? 'watching' : 'paused'});
  }
  function bind(el, fn){
    el.onclick = e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-cf]') : null;
      if (t) fn(t.getAttribute('data-cf'), t);
    };
  }
  function sw(on, act, attrs){
    return `<button class="cf-sw${on ? ' cf-sw-on' : ''}" role="switch" aria-checked="${!!on}" data-cf="${act}" ${attrs||''}><span class="cf-sw-knob"></span></button>`;
  }
  function seg(key, opts, cur){
    return `<div class="cf-seg" role="radiogroup">${opts.map(o => `<button role="radio" aria-checked="${o[0]===cur}" class="${o[0]===cur ? 'cf-seg-on' : ''}" data-cf="route" data-k="${key}" data-v="${o[0]}">${esc(o[1])}</button>`).join('')}</div>`;
  }

  /* ---------- Activity ---------- */
  function renderActivity(el){
    ensureSources();
    const s = AA.state, p = proj(), paused = s.status === 'paused', n = s.sources.length;
    const blockers = s.messages.filter(m => m.kind === 'blocker' && m.status === 'open');
    let now;
    if (s.status === 'checking') now = `Checking ${n} sources…`;
    else if (paused) now = 'Paused by you';
    else if (s.status === 'offline') now = `${esc(p.name)} is offline on ${esc(p.machine)} · I'll retry when it's back`;
    else if (s.status === 'needs') now = `${esc(p.name)} needs you · ${s.needs} waiting`;
    else if (s.status === 'new') now = `Getting ${esc(p.name)} set up`;
    else now = `Watching ${esc(p.name)} · next look ~20 min — I check sooner when files change`;
    const dot = s.status === 'checking' ? 'cf-dot-checking' : paused ? 'cf-dot-paused' : s.status === 'offline' ? 'cf-dot-offline' : s.status === 'needs' ? 'cf-dot-needs' : 'cf-dot-watching';
    const checks = [
      ...s.messages.filter(m => m.kind === 'check').reverse().map(m => ({label:m.text, icon:'tick'})),
      ...SEED_CHECKS
    ].slice(0, 5);

    const needsHtml = s.needs > 0 ? `
      <section class="cf-sec"><div class="cf-h">Needs you</div>
        ${blockers.length ? blockers.map(m => `<div class="cf-item"><span class="cf-clip">${esc(m.text)}</span><button class="aa-btn cf-mini" data-cf="go-chat">Open</button></div>`).join('') : '<p class="cf-sub">Nothing open right now.</p>'}
      </section>` : '';

    el.innerHTML = `<div class="cf-wrap">
      <section class="cf-sec"><div class="cf-h">Now</div>
        <div class="cf-now"><span class="cf-dot ${dot}"></span>
          <div class="cf-now-text">${now}${paused ? ' · <button class="cf-link" data-cf="resume">Resume</button>' : ''}</div>
        </div>
      </section>
      ${needsHtml}
      <section class="cf-sec"><div class="cf-h">Recent checks</div>
        ${checks.map(c => `<div class="cf-muted-row cf-item"><span class="cf-ic">${ICON[c.icon]}</span><span class="cf-clip">${esc(c.label)}</span></div>`).join('')}
      </section>
      <section class="cf-sec"><div class="cf-h">Scheduled</div>
        <p class="cf-sub">No fixed schedule — Apex decides when to look.</p>
        <div style="margin-top:6px">
        ${ui.schedItems.map(it => `<div class="cf-sched">
          <div class="cf-item"><span class="cf-clip">${esc(it.label)}</span>${it.paused ? '<span class="cf-tag">Paused</span>' : ''}<button class="cf-icon" data-cf="sched-menu" data-id="${it.id}" aria-label="More options">${ICON.more}</button></div>
          ${ui.menu === it.id ? `<div class="cf-inline"><button class="cf-link" data-cf="sched-pause" data-id="${it.id}">${it.paused ? 'Resume' : 'Pause'}</button><button class="cf-link cf-danger" data-cf="sched-del" data-id="${it.id}">Delete</button></div>` : ''}
        </div>`).join('')}
        </div>
        <button class="cf-link cf-sched-add" data-cf="sched-add">+ Add a fixed time</button>
      </section>
      <section class="cf-sec"><div class="cf-h">Watching</div>
        <div class="cf-chips">${s.sources.length ? s.sources.map(x => `<span class="aa-chip cf-chip"><span class="cf-ic">${KIND_ICON[x.kind] || ICON.doc}</span><span class="cf-clip">${esc(x.label)}</span><button class="cf-x" data-cf="src-rm" data-id="${x.id}" aria-label="Stop watching ${esc(x.label)}">${ICON.x}</button></span>`).join('') : '<p class="cf-sub">Nothing is watched yet.</p>'}</div>
        <p class="cf-sub cf-drop">+ Drag files or chats onto Apex to add more</p>
      </section>
      <div class="cf-foot">
        <button class="aa-btn cf-big" data-cf="pause">${paused ? 'Resume Apex' : 'Pause Apex'}</button>
        <button class="aa-btn aa-btn-primary cf-big" data-cf="check-now"${s.status === 'checking' ? ' disabled' : ''}>Check now</button>
      </div>
    </div>`;
    bind(el, (act, t) => activityAction(el, act, t));
  }

  function activityAction(el, act, t){
    const id = t.getAttribute('data-id');
    switch (act){
      case 'resume': AA.set({status:'watching'}); break;
      case 'pause': togglePause(); break;
      case 'go-chat': AA.set({tab:'chat'}); break;
      case 'check-now': {
        const n = AA.state.sources.length;
        AA.set({status:'checking'});
        AA.addMessage({from:'agent', kind:'check', text:`Checked ${n} sources · nothing new · now`});
        setTimeout(() => { if (AA.state.status === 'checking') AA.set({status:'watching'}); }, 2500);
        break;
      }
      case 'sched-menu': ui.menu = ui.menu === id ? null : id; break;
      case 'sched-pause': { const it = ui.schedItems.find(x => x.id === id); if (it) it.paused = !it.paused; ui.menu = null; break; }
      case 'sched-del': ui.schedItems = ui.schedItems.filter(x => x.id !== id); ui.menu = null; break;
      case 'sched-add': ui.schedItems = [...ui.schedItems, {id:'sch-' + (schedSeq++), label:'Daily 18:00 · end-of-day note', paused:false}]; break;
      case 'src-rm': AA.set({sources: AA.state.sources.filter(x => x.id !== id)}); break;
    }
    renderActivity(el);
  }

  /* ---------- Settings ---------- */
  function renderSettings(el){
    const s = AA.state, rules = s.rules || DEFAULT_RULES, q = s.quiet, r = s.routes, p = proj();
    const paused = s.status === 'paused';
    const notes = ui.moreNotes
      ? [...ui.memories, {id:'m4', text:'Ask before any paid job'}, {id:'m5', text:'Short morning summaries'}]
      : ui.memories;
    const modelLabel = ui.model === 'GPT-6 Luna' ? 'GPT-6 Luna (default from Settings)' : ui.model;

    el.innerHTML = `<div class="cf-wrap">
      <section class="cf-sec"><div class="cf-h">Make it yours</div><div data-cf-look></div></section>

      <section class="cf-sec"><div class="cf-h">Where to reach you</div>
        <div class="cf-route"><div class="cf-label">Routine updates</div>${seg('routine', ROUTINE, r.routine)}</div>
        <div class="cf-route"><div class="cf-label">Decisions</div>${seg('decisions', DECISION, r.decisions)}</div>
      </section>

      <section class="cf-sec"><div class="cf-h">What needs you</div>
        ${RULE_ROWS.map(([k, t, d]) => `<div class="cf-row-sw"><div class="cf-grow"><div>${t}</div><div class="cf-sub">${d}</div></div>${sw(rules[k], 'rule', `data-k="${k}"`)}</div>`).join('')}
      </section>

      <section class="cf-sec"><div class="cf-h">Quiet hours</div>
        <div class="cf-row-sw"><div class="cf-grow"><div>${esc(q.from)} – ${esc(q.to)}</div><div class="cf-sub">Decisions wait until morning unless a deadline is under 24 h away.</div></div>${sw(q.on, 'quiet')}</div>
      </section>

      <section class="cf-sec"><div class="cf-h">What I remember</div>
        ${notes.map(m => `<div class="cf-item"><span class="cf-clip">${esc(m.text)}</span><button class="cf-icon" data-cf="forget" data-id="${m.id}" aria-label="Forget this note">${ICON.x}</button></div>`).join('')}
        ${ui.moreNotes ? '' : '<button class="cf-link" data-cf="notes-all">See all notes</button>'}
      </section>

      <section class="cf-sec"><div class="cf-h">Model</div>
        <div class="cf-row-sw"><div class="cf-grow"><div>${esc(modelLabel)}</div></div><button class="cf-link" data-cf="model-change">Change</button></div>
        ${ui.modelOpen ? `<div class="cf-inline" style="padding-top:8px">${MODELS.map(m => `<button class="cf-link${m === ui.model ? ' cf-on' : ''}" data-cf="model-pick" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}
      </section>

      <section class="cf-sec"><div class="cf-h">Visibility</div>
        <div class="cf-row-sw"><div class="cf-grow"><div>Hide the avatar</div><div class="cf-sub">Apex keeps working. The avatar shrinks to a small edge tab.</div></div>${sw(s.hidden, 'hide')}</div>
        <div class="cf-row-sw"><div class="cf-grow"><div>Pause Apex</div><div class="cf-sub">Stops checking until you resume. Nothing new is read.</div></div>${sw(paused, 'pause')}</div>
        <p class="cf-sub" style="margin-top:8px">Reduce motion follows macOS. Open or close Apex with <span class="aa-kbd">⌘J</span>.</p>
      </section>

      <section class="cf-sec cf-end">${ui.confirmStop
        ? `<p class="cf-sub" style="margin-bottom:6px">${esc(p.name)} leaves Apex's watch list. Its threads and files stay where they are.</p><div class="cf-inline"><button class="cf-link cf-danger" data-cf="stop-yes">Stop watching ${esc(p.name)}</button><button class="cf-link" data-cf="stop-no">Cancel</button></div>`
        : `<button class="cf-link cf-danger" data-cf="stop-ask">Stop watching ${esc(p.name)}</button>`}
      </section>
    </div>`;

    const sub = el.querySelector('[data-cf-look]');
    if (sub){
      if (AA.parts.av && typeof AA.parts.av.renderLook === 'function') AA.parts.av.renderLook(sub);
      else sub.innerHTML = '<p class="cf-sub">The avatar editor (shape, colour, eyes, glasses) appears here.</p>';
    }
    bind(el, (act, t) => settingsAction(el, act, t));
  }

  function settingsAction(el, act, t){
    const k = t.getAttribute('data-k'), v = t.getAttribute('data-v'), id = t.getAttribute('data-id');
    switch (act){
      case 'route': AA.set({routes: {...AA.state.routes, [k]: v}}); break;
      case 'rule': { const rules = {...(AA.state.rules || DEFAULT_RULES)}; rules[k] = !rules[k]; AA.set({rules}); break; }
      case 'quiet': AA.set({quiet: {...AA.state.quiet, on: !AA.state.quiet.on}}); break;
      case 'forget': ui.memories = ui.memories.filter(m => m.id !== id); break;
      case 'notes-all': ui.moreNotes = true; break;
      case 'model-change': ui.modelOpen = !ui.modelOpen; break;
      case 'model-pick': ui.model = v; ui.modelOpen = false; break;
      case 'hide': AA.set({hidden: !AA.state.hidden}); break;
      case 'pause': togglePause(); break;
      case 'stop-ask': ui.confirmStop = true; break;
      case 'stop-no': ui.confirmStop = false; break;
      case 'stop-yes': {
        const cur = AA.state.project;
        const rest = AA.state.projects.filter(x => x.id !== cur);
        AA.set({projects: rest, project: rest[0] ? rest[0].id : null, switcher: false});
        ui.confirmStop = false;
        break;
      }
    }
    renderSettings(el);
  }

  /* ---------- Project switcher ---------- */
  function renderSwitcher(el){
    const s = AA.state;
    el.innerHTML = `<div class="cf-wrap">
      <div class="cf-h">Projects</div>
      ${s.projects.map(p => {
        const cur = p.id === s.project;
        const kind = p.status === 'needs' ? 'needs' : p.status === 'paused' ? 'paused' : p.status === 'offline' ? 'offline' : 'watching';
        return `<button class="cf-proj" data-cf="proj" data-id="${esc(p.id)}" aria-current="${cur}">
          <span class="cf-dot cf-dot-${kind}"></span>
          <span class="cf-grow"><span class="cf-proj-name">${esc(p.name)}</span><span class="cf-sub">${esc(p.machine)}</span></span>
          ${p.needs > 0 ? `<span class="cf-count">${p.needs}</span>` : ''}
          <span class="cf-tick">${cur ? ICON.check : ''}</span>
        </button>`;
      }).join('')}
      <div class="cf-foot-sw">
        <button class="cf-link" data-cf="add-proj">+ Watch another project</button>
        <p class="cf-sub">One Apex for all projects.</p>
      </div>
    </div>`;
    bind(el, (act, t) => {
      if (act === 'proj') AA.set({project: t.getAttribute('data-id'), switcher: false});
      else if (act === 'add-proj' && !AA.state.projects.some(p => p.id === 'docs')){
        AA.set({projects: [...AA.state.projects, {id:'docs', name:'Docs site', folder:'~/code/docs', machine:'This Mac', status:'watching', needs:0}]});
      }
      renderSwitcher(el);
    });
  }

  AA.part('cf', {mount(){}, renderActivity, renderSettings, renderSwitcher});
})();
