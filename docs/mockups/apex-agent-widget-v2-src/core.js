(function(){
  const listeners = {};
  const saved = (() => { try { return JSON.parse(localStorage.getItem('aa2-pos')||'null'); } catch { return null; } })();
  // Fields that belong to ONE project. The top-level copies always show the current project;
  // AA.switchProject() saves them into byProject[old] and loads byProject[new].
  const SCOPED = ['status','needs','setup','sources','messages'];
  const blank = () => ({status:'new', needs:0, setup:'none', sources:[], messages:[]});
  const AA = window.AA = {
    parts: {},
    SCOPED,
    state: {
      page:'threads', open:false, size:'compact', tab:'chat', hidden:false,
      pos: saved || {edge:'right', y: 420}, project:'mobile',
      projects:[
        {id:'mobile', name:'Mobile launch', folder:'~/code/mobile-launch', machine:'This Mac'},
        {id:'deck', name:'Apex Deck', folder:'/srv/apex-deck', machine:'Hetzner'}],
      byProject:{ mobile: blank(), deck: blank() },
      ...blank(),
      context:{label:'Threads › Release thread'}, switcher:false, browserFrozen:false,
      look:{shape:'orb', color:'mint', eyes:true, glasses:false},
      quiet:{on:false, from:'22:00', to:'08:00'}, routes:{routine:'panel', decisions:'bubble+phone'}
    },
    on(e, fn){ (listeners[e] ||= []).push(fn); },
    emit(e, p){ (listeners[e]||[]).forEach(fn => { try { fn(p, AA.state); } catch(err){ console.error('[AA '+e+']', err); } }); },
    set(patch){ Object.assign(AA.state, patch);
      if (patch.pos) try { localStorage.setItem('aa2-pos', JSON.stringify(patch.pos)); } catch {}
      AA.emit('change', patch); },
    part(name, obj){ AA.parts[name] = obj; },
    addMessage(m){ AA.state.messages = [...AA.state.messages, {time: m.time || 'now', id: m.id || ('m'+Math.random().toString(36).slice(2,8)), ...m}]; AA.emit('change', {messages:true}); },
    bubble(b){ AA.emit('bubble', b); },
    esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
    layer(){ return document.getElementById('aa-layer').getBoundingClientRect(); },

    /* ---------- per-project scope ---------- */
    view(id){ // scoped fields for any project; the current one is read live
      const s = AA.state; if (id === s.project) { const o = {}; SCOPED.forEach(k => o[k] = s[k]); return o; }
      return s.byProject[id] || blank(); },
    totalNeeds(){ return AA.state.projects.reduce((n, p) => n + (AA.view(p.id).needs || 0), 0); },
    switchProject(id){ const s = AA.state; if (id === s.project || !s.byProject[id]) { AA.set({switcher:false}); return; }
      const cur = {}; SCOPED.forEach(k => cur[k] = s[k]);
      const by = {...s.byProject, [s.project]: cur};
      AA.set({...by[id], byProject: by, project: id, switcher:false}); },
    loadProjects(map){ // steps: replace every project's scoped data at once
      const by = {}; AA.state.projects.forEach(p => by[p.id] = {...blank(), ...(map[p.id]||{})});
      AA.set({...by[AA.state.project], byProject: by}); },

    /* ---------- per-project writes ---------- */
    patchProject(id, patch){ // write scoped fields to one project, current or not
      const s = AA.state; if (id === s.project) return AA.set(patch);
      AA.set({byProject: {...s.byProject, [id]: {...(s.byProject[id] || blank()), ...patch}}}); },
    addMessageTo(id, m){
      const msg = {time: m.time || 'now', id: m.id || ('m'+Math.random().toString(36).slice(2,8)), ...m};
      AA.patchProject(id, {messages: [...AA.view(id).messages, msg]}); },

    /* ---------- adding a source (drag-drop) ---------- */
    // payload = {kind:'file'|'thread', ref, label, project}. Resolves {ok, reason?}.
    // The destination is the project that was open at the moment of the drop. Switching projects
    // while it saves doesn't move the result: only that project's sources and chat change.
    // Emits 'source-add' {phase:'adding'|'added'|'duplicate'|'failed', label, project, reason?}.
    addSource(payload){
      const s = AA.state, dest = s.project, key = payload.kind + ':' + payload.ref, p = s.projects.find(x => x.id === dest);
      const say = (phase, reason) => AA.emit('source-add', {phase, label: payload.label, kind: payload.kind, project: dest, reason});
      if (AA.view(dest).sources.some(x => (x.kind + ':' + (x.ref || x.label)) === key && !x.failed)) { say('duplicate'); return Promise.resolve({ok:false, reason:'duplicate'}); }
      const id = 'add-' + Math.random().toString(36).slice(2,7);
      AA.patchProject(dest, {sources: [...AA.view(dest).sources, {id, kind: payload.kind, ref: payload.ref, label: payload.label, why: 'you dropped it here', on: true, pending: true}]});
      say('adding');
      return new Promise(res => setTimeout(() => {
        let reason = null;
        if (payload.project && payload.project !== dest) reason = 'It belongs to ' + ((s.projects.find(x => x.id === payload.project)||{}).name || 'another project') + ', not ' + (p ? p.name : 'this project') + '.';
        else if (String(payload.ref).startsWith('..')) reason = "It's outside the " + (p ? p.name : 'project') + ' folder, so I can\'t read it.';
        const list = AA.view(dest).sources;
        if (reason) {
          AA.patchProject(dest, {sources: list.filter(x => x.id !== id)});
          say('failed', reason); res({ok:false, reason}); }
        else {
          AA.patchProject(dest, {sources: list.map(x => x.id === id ? {...x, pending:false} : x)});
          say('added'); res({ok:true}); }
      }, 1100));
    },

    /* ---------- geometry ---------- */
    AVATAR: 56, GLOW: 16, EDGE: 20,   // EDGE >= GLOW + 4 so the glow never leaves the window
    browserRect(){ // the docked browser's native view, in #aa-layer coords (null when not on that page)
      const el = document.querySelector('.sh-native'); if (!el || AA.state.page !== 'browser') return null;
      const L = AA.layer(), r = el.getBoundingClientRect(); if (!r.width) return null;
      return {left: r.left - L.left, top: r.top - L.top, width: r.width, height: r.height}; },
    avatarBox(){ // where the avatar sits: {left, top, size}; keeps clear of the docked browser
      const L = AA.layer(), s = AA.state, A = AA.AVATAR, E = AA.EDGE, b = AA.browserRect();
      let right = L.width;                        // usable area is [0, right)
      if (b && s.pos.edge === 'right') right = b.left;
      const left = s.pos.edge === 'right' ? right - A - E : E;
      const top = Math.max(E, Math.min(s.pos.y, L.height - A - E));
      return {left, top, size: A}; },
    panelRect(){
      const L = AA.layer(), s = AA.state, a = AA.avatarBox(), w = s.size === 'tall' ? 460 : 380;
      const h = s.size === 'tall' ? L.height - 24 : Math.min(560, L.height - 24);
      const left = s.pos.edge === 'right' ? Math.max(12, a.left - 16 - w) : a.left + a.size + 16;
      let top = s.size === 'tall' ? 12 : a.top + a.size/2 - h/2;
      top = Math.max(12, Math.min(top, L.height - h - 12));
      return {left, top, width:w, height:h};
    }
  };

  // Docked browser: like Deck's BrowserView, the native page is drawn ABOVE the window. While any
  // element with class "aa-overlay" overlaps it, show a picture of the page instead (browserFrozen).
  function freezeCheck(){
    const b = AA.browserRect(); let hit = false;
    if (b) { const L = AA.layer();
      document.querySelectorAll('.aa-overlay').forEach(o => { const r = o.getBoundingClientRect(); if (!r.width || !r.height) return;
        if (getComputedStyle(o).visibility === 'hidden' || +getComputedStyle(o).opacity === 0) return;
        const x = r.left - L.left, y = r.top - L.top;
        if (x < b.left + b.width && x + r.width > b.left && y < b.top + b.height && y + r.height > b.top) hit = true; }); }
    if (hit !== AA.state.browserFrozen) { AA.state.browserFrozen = hit; document.documentElement.classList.toggle('aa-browser-frozen', hit); AA.emit('change', {browserFrozen: hit}); }
  }
  AA.freezeCheck = freezeCheck;
  window.addEventListener('DOMContentLoaded', () => {
    for (const [n, p] of Object.entries(AA.parts)) { try { p.mount && p.mount(); } catch(err){ console.error('[mount '+n+']', err); } }
    AA.emit('change', {});
    AA.emit('ready');
    setInterval(freezeCheck, 150);
  });
})();
