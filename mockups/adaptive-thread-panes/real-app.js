// Runtime for the adaptive-thread-panes mockup. Every node it shows is a
// clone of a <template> captured from Deck's real UI (see build-real.mjs).
//
// 2026-11-08, zoom revision. The panes beside the focus pane (or every pane in
// Even grid) sit on a map. At 100% the map is the same layout as before and
// scrolls the same way. Pinch, Ctrl/⌘ + scroll or the − / + buttons zoom it
// toward the pointer; scrolling or dragging the empty background pans it. Each
// pane shows as much as its size on screen allows:
//   live pane (the real 28px title bar, messages, every action) → drawn card → chip.
// Past GROUP_AT threads (scale test only) the map nests threads in blocks of
// 10 × 10, so blocks of 100, 10,000, 1,000,000 … open as you zoom in. Only what
// is on screen is built or drawn.
(() => {
  'use strict';
  const S = window.THREAD_SNAPSHOT;
  const BOTS = window.MK_BOTS;
  const CELLS = window.MK_CELLS;
  const threads = S.threads;
  const byId = new Map(threads.map((t) => [t.id, t]));
  // Threads made with + New live in state, so Reset drops them. Synthetic
  // scale-test threads are made on demand from their number.
  const T = (id) => byId.get(id) || state.added.find((t) => t.id === id) || synThread(id);
  const members = (t) => [...(t.members || []), ...(state.extra.get(t.id) || [])];
  const allThreads = () => [...[...state.added].reverse(), ...threads];
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const tpl = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);
  const TOOL = { claude_code: 'Claude Code', codex: 'Codex', ollama: 'Ollama', gemini: 'Antigravity / Gemini', grok: 'Grok', muse: 'Muse Code' };
  const ACCESS = { read: 'Read only', ask: 'Asks first', edits: 'Can edit files', full: 'Full access' };
  const botByName = new Map(Object.entries(BOTS).map(([id, b]) => [b.name.toLowerCase(), { id, ...b }]));
  const botFor = (member) => (member && BOTS[member.id]) ? { id: member.id, ...BOTS[member.id] } : botByName.get(String(member && member.name || '').toLowerCase()) || null;
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const compact = (n) => compactFmt.format(n);
  const botCount = (n) => n ? `${fmt(n)} agent${n === 1 ? '' : 's'}` : 'No agents yet';
  // Scale test threads carry a virtual agent count; real threads count members.
  const agentTotal = (t) => (t && t.virtualAgents) || members(t).length;
  const toolLabel = (b) => b ? (TOOL[b.tool] || b.model || 'Custom') : 'Agent';
  const EFFORT = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  // Tool · model · effort · access, skipping anything left on Default.
  const agentMeta = (b) => [toolLabel(b), b.made && b.model, b.made && EFFORT[b.effort] && `${EFFORT[b.effort]} effort`, ACCESS[b.access] || 'Full access'].filter(Boolean).join(' · ');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (x, a, b) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
  const hash = (i) => { let x = (i ^ 0x9e3779b9) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0; x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0; return (x ^ (x >>> 16)) >>> 0; };
  const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const motionOff = () => stillMotion.matches;
  const savedBots = () => Object.entries(BOTS).filter(([, b]) => !b.made).map(([id, b]) => ({ id, ...b }));
  let th = null;
  const theme = () => {
    if (th) return th;
    const cs = getComputedStyle(document.body); const v = (k, d) => cs.getPropertyValue(k).trim() || d;
    th = { bg: v('--bg', '#000'), panel: v('--panel', '#111'), line: v('--line', '#2a2a2a'), text: v('--text', '#eee'), muted: v('--muted', '#8b8b8b'), accent: v('--accent', '#e8846b') };
    return th;
  };

  const ui = {
    grid: $('#mk-grid'), ws: $('#mk-ws'), count: $('#mk-host-count'),
    input: $('#mk-input'), to: $('#mk-to'), send: $('#mk-shared .round-send'), chips: $('#mk-shared .composer-bots'),
    detTitle: $('#mk-det-title'), detSub: $('#mk-det-sub'), detBots: $('#details-bots-body'),
    picker: $('.layout-picker'), pickerBtn: $('.layout-picker-trigger'), reset: $('#mk-reset')
  };

  const fresh = () => ({
    order: threads.map((t) => t.id), closed: new Set(), focusFrac: 0.58, colFracs: new Map(),
    selected: byId.has(S.focusedId) ? S.focusedId : threads[0].id, full: null, layout: 'left', gridDir: 'grid',
    drafts: new Map(), sent: new Map(), added: [], extra: new Map(), made: 0, newAgents: [], scaleThreads: 0, scaleAgents: 0,
    // Map navigation: one camera per layout, the zoom history behind Back, and
    // each thread's reading place (kept while its pane is off screen).
    cams: new Map(), hist: [], scrolls: new Map(), synClosed: [], fieldCams: new Map(), mini: null,
    flatZoom: 1,
    multiSelected: null, // Set<string> when ⌘-multi is active
    multiDraft: '',
    multiTagged: false,
    multiCollapsed: true,
    multiOverrides: new Map(), // threadId -> agentName override for this send only
    multiAgentMenu: null, // {threadId, anchor}
    multiAttachmentCache: new Map(),
    clipboardScope: Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-'),
    multiAttachments: [], // {name,id,dest:Set}
    multiResults: new Map(), // threadId -> 'ok'|'fail'
    multiPicker: null, // # thread / @ agent picker state
    multiPending: new Map(),
    multiFailNext: new Set(),
    multiPreviewed: null
  });
  let state = fresh();
  const panes = new Map();

  // ---------- Mockup only: synthetic threads for the scale test ----------
  // Made from their number when needed, so nothing is stored per thread. Each one
  // says "synthetic" in its title bar and its transcript.
  const SYN = 'syn-';
  const isSyn = (id) => typeof id === 'string' && id.startsWith(SYN);
  const synNum = (id) => Number(id.slice(SYN.length));
  const synCache = new Map();
  const synLead = (s) => { const pool = savedBots(); const h = hash(s + 1); return [pool[h % pool.length], pool[(h >>> 9) % pool.length]]; };
  const synThread = (id) => {
    if (!isSyn(id)) return undefined;
    const s = synNum(id);
    if (!(s >= 0 && s < state.scaleThreads) || state.synClosed.includes(s)) return undefined;
    let t = synCache.get(id); if (t) return t;
    const [a, b] = synLead(s);
    const mem = [{ id: a.id, name: a.name }]; if (b.id !== a.id) mem.push({ id: b.id, name: b.name });
    t = { id, title: `Synthetic thread ${fmt(s + 1)}`, synthetic: true, members: mem, messages: [
      { speaker: 'You', text: `Synthetic prompt ${fmt(s + 1)}.` },
      { speaker: a.name, text: 'Synthetic reply. This thread is made up on demand for the scale test, so nothing in it is real or saved.' }] };
    if (synCache.size > 400) synCache.delete(synCache.keys().next().value);
    synCache.set(id, t); return t;
  };

  // ---------- small helpers ----------
  const toast = (() => {
    const el = document.createElement('div'); el.className = 'mk-toast'; el.setAttribute('role', 'status'); document.body.append(el);
    let timer = 0;
    return (text) => { el.textContent = text; el.classList.add('mk-show'); clearTimeout(timer); timer = setTimeout(() => el.classList.remove('mk-show'), 2600); };
  })();
  const paintIdenticon = (el, seed, color) => {
    const cells = CELLS[seed] || CELLS.__fallback;
    el.style.setProperty('--who', color);
    $$('i', el).forEach((i, n) => { const on = !!cells[n]; i.className = on ? 'on' : ''; i.style.setProperty('--a', on ? '100%' : '10%'); });
  };
  const fitSteps = (steps, set, fits) => { for (const step of steps) { set(step); if (fits()) return; } };
  // Pane title text sits in an inner span so a cut-off name can scroll (marquee).
  const setTitleText = (title, text) => {
    const tt = document.createElement('span'); tt.className = 'mk-tt'; tt.textContent = text;
    title.replaceChildren(tt);
  };
  const fitHead = (head) => {
    const title = $('.pane-title', head);
    if (title) title.classList.remove('mk-marquee');
    fitSteps(['full', 'compact', 'tight', 'min'], (s) => { head.dataset.fit = s; }, () =>
      head.scrollWidth <= head.clientWidth && (!title || title.scrollWidth <= title.clientWidth || title.clientWidth >= 150));
    // Only when the buttons themselves no longer fit: □ goes first (double-click
    // still goes full screen), then ⋯. × stays until the pane becomes a drawn card.
    const roomy = () => head.scrollWidth <= head.clientWidth && (!title || title.clientWidth >= 28);
    if (!roomy()) fitSteps(['nomax', 'xonly'], (s) => { head.dataset.fit = s; }, roomy);
    // When the name still doesn't fit it shows "…"; hovering the bar slides it
    // back and forth (reduced motion keeps the ellipsis, see real-mk.css).
    const tt = title && $('.mk-tt', title);
    if (!tt) return;
    const over = Math.ceil(tt.getBoundingClientRect().width - title.clientWidth);
    if (over > 2) {
      title.style.setProperty('--mk-shift', `${-over}px`);
      title.style.setProperty('--mk-dur', `${(2.4 + over / 28).toFixed(2)}s`);
      title.classList.add('mk-marquee');
    }
  };
  // An empty pane drops its least useful lines until "+ Add agents" fits.
  const fitEmpty = (p) => {
    const tr = $('.transcript', p); const empty = tr && $('.empty', tr);
    if (!empty || p.classList.contains('mk-tile')) { delete p.dataset.mkEmpty; return; }
    fitSteps(['full', 'short', 'tiny'], (s) => { p.dataset.mkEmpty = s; }, () => tr.scrollHeight <= tr.clientHeight + 1);
  };
  // Same as Deck's ChatPane: the chip row sheds details (full → levels → names →
  // faces) and past that it simply scrolls sideways. No overflow UI of our own.
  const fitChips = (row) => {
    fitSteps(['full', 'levels', 'names', 'faces'], (s) => { row.dataset.fit = s; }, () => row.scrollWidth <= row.clientWidth);
  };

  // Inline Markdown the way Deck's renderer marks it up: strong, code, links.
  const inline = (parent, text) => {
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    let last = 0; let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) { const s = document.createElement('strong'); s.textContent = tok.slice(2, -2); parent.append(s); }
      else if (tok.startsWith('`')) { const c = document.createElement('code'); c.textContent = tok.slice(1, -1); parent.append(c); }
      else { const a = document.createElement('a'); a.className = 'msg-link'; a.href = '#'; a.textContent = tok.slice(1, tok.indexOf('](')); a.addEventListener('click', (e) => e.preventDefault()); parent.append(a); }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  };
  const markdown = (md, text) => {
    const lines = String(text).split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (line.startsWith('```')) {
        const lang = line.slice(3).trim(); const body = []; i++;
        while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
        i++;
        const box = document.createElement('div'); box.className = 'md-code';
        const head = document.createElement('div'); head.className = 'md-code-head';
        const l = document.createElement('span'); l.textContent = lang || 'text';
        const acts = document.createElement('span'); acts.className = 'md-code-actions';
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy'; acts.append(copy);
        head.append(l, acts);
        const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = body.join('\n'); pre.append(code);
        box.append(head, pre); md.append(box); continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { const p = document.createElement('p'); p.className = `md-heading level-${h[1].length}`; p.setAttribute('role', 'heading'); p.setAttribute('aria-level', String(h[1].length)); inline(p, h[2]); md.append(p); i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const numbered = /^\s*\d+\./.test(line);
        const ul = document.createElement('ul'); ul.className = 'md-list' + (numbered ? ' numbered' : '');
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          const mm = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
          const li = document.createElement('li'); li.style.marginLeft = mm[1].length >= 2 ? '1.4em' : '0em';
          const mk = document.createElement('span'); mk.className = 'md-marker'; mk.textContent = /\d/.test(mm[2]) ? mm[2] : '•';
          const it = document.createElement('span'); it.className = 'md-item'; inline(it, mm[3]);
          li.append(mk, it); ul.append(li); i++;
        }
        md.append(ul); continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+)/.test(lines[i])) para.push(lines[i++]);
      const p = document.createElement('p'); inline(p, para.join(' ')); md.append(p);
    }
  };
  const messageNode = (thread, msg) => {
    if (msg.speaker === 'You') {
      const row = tpl('mk-tpl-human');
      $('.bubble', row).textContent = msg.text;
      return row;
    }
    const row = tpl('mk-tpl-bot');
    const member = (thread.members || []).find((m) => m.name === msg.speaker) || { name: msg.speaker };
    const b = botFor(member);
    const color = b ? b.color : '#8b8b8b';
    paintIdenticon($('.identicon', row), b ? b.seed : '', color);
    const bubble = $('.bubble', row);
    bubble.style.setProperty('--agent-color', color);
    $('.speaker', row).textContent = msg.speaker;
    markdown($('.md', row), msg.text);
    $$('[aria-label]', row).forEach((el) => el.setAttribute('aria-label', el.getAttribute('aria-label').replace(/Ada|Ben/g, msg.speaker)));
    return row;
  };
  const lastBotName = (thread) => {
    const names = new Set(members(thread).map((m) => m.name));
    const list = [...(thread.messages || []), ...(state.sent.get(thread.id) || [])];
    for (let i = list.length - 1; i >= 0; i--) {
      if (!/^(you|user)$/i.test(list[i].speaker)) continue;
      const mentions = explicitMentions(list[i].text || '');
      for (let j = mentions.length - 1; j >= 0; j--) {
        const agent = members(thread).find((m) => m.name.toLowerCase() === mentions[j]);
        if (agent) return agent.name;
      }
    }
    const original = thread.messages || [];
    for (let i = original.length - 1; i >= 0; i--) if (names.has(original[i].speaker)) return original[i].speaker;
    return (members(thread)[0] && members(thread)[0].name) || null;
  };
  const allMessages = (thread) => [...(thread.messages || []), ...(state.sent.get(thread.id) || [])];

  // ---------- multi-select + slice + agent dropdown ----------
  const hasMulti = () => state.multiSelected && (state.multiSelected.size > 1 || state.multiTagged);
  const multiIds = () => hasMulti() ? [...state.multiSelected] : [state.selected];
  const explicitMentions = (text) => {
    const re = /(?:^|[\s(>"'\u201C])@([A-Za-z][\w-]{1,23})\b/g;
    const out = []; let m;
    while ((m = re.exec(text))) {
      const raw = m[1]; const low = raw.toLowerCase();
      if (low === 'all') continue;
      const end = m.index + m[0].length;
      if (text[end] === '.' && /[A-Za-z]{2,}/.test(text.slice(end + 1, end + 5))) continue;
      const previous=out.indexOf(low);if(previous>=0)out.splice(previous,1);out.push(low);
    }
    return out;
  };
  const memberNamesLower = (thread) => new Set(members(thread).map((mm) => (mm.name || '').toLowerCase()));
  const agentsInThread = (thread) => members(thread).map((mm) => mm.name);
  const findAgentInThread = (thread, nameLower) => members(thread).find((mm) => (mm.name || '').toLowerCase() === nameLower);
  // Typed mentions take precedence over a per-send dropdown override.
  const recipientFor = (thread, explicit, overrideName) => {
    if (overrideName) {
      const has = memberNamesLower(thread);
      if (!has.has(overrideName.toLowerCase())) return { agent: null, missing: [overrideName.toLowerCase()], explicit, override: overrideName };
      const f = findAgentInThread(thread, overrideName.toLowerCase());
      return { agent: f ? f.name : overrideName, missing: [], explicit, override: overrideName };
    }
    if (explicit.length) {
      const has = memberNamesLower(thread);
      const missing = explicit.filter((nm) => !has.has(nm));
      if (missing.length) return { agent: null, missing, explicit };
      const found = findAgentInThread(thread, explicit[explicit.length - 1]);
      return { agent: found ? found.name : explicit[0], missing: [], explicit };
    }
    return { agent: lastBotName(thread), missing: [], explicit: [] };
  };

  // Only picker-created stable-ID tokens delimit slices. Titles are presentation.
  const threadToken = (id) => `⟦thread:${id}⟧`;
  const attachmentToken = (id) => `⟦file:${id}⟧`;
  const attachmentRefs = (text) => [...text.matchAll(/⟦file:([^⟧]*)⟧/g)].map(m=>m[1]);
  const readableAttachments = (text) => text.replace(/⟦file:([^⟧]*)⟧/g,(_,id)=>{const a=state.multiAttachments.find(a=>a.id===id);return a?`[${a.label}: ${a.name}]`:'[Missing attachment]';});
  const parseThreadSlices = (text) => {
    const tags = [...text.matchAll(/⟦thread:([^⟧]*)⟧/g)].map((m) => ({id:m[1], at:m.index, len:m[0].length}));
    const duplicates = new Set(), errors = [], slices = [], lines = [];
    const unresolved = tags.filter((tag) => !T(tag.id)).map((tag) => tag.id);
    if (text.includes('⟦thread:') && tags.length !== text.split('⟦thread:').length - 1) unresolved.push('incomplete tag');
    let offset=0;
    for(const line of text.split('\n')) {
      const own=tags.filter(t=>t.at>=offset && t.at<offset+line.length);
      const seen=new Set();for(const tag of own){if(seen.has(tag.id))duplicates.add(tag.id);seen.add(tag.id);}
      const entries=[];
      if(!own.length) {if(tags.length && line.trim())errors.push('Every nonempty line needs a #thread tag.');}
      else {
        const parts=[];let at=0;
        for(const tag of own){parts.push(line.slice(at,tag.at-offset).trim());at=tag.at-offset+tag.len;}
        parts.push(line.slice(at).trim());
        const adjacent=parts.slice(1,-1).every(t=>!t);
        if(adjacent) {
          const body=[parts[0],parts.at(-1)].filter(Boolean).join(' ');
          for(const tag of own)entries.push({threadId:tag.id,text:body,tag,group:own.length>1});
        } else if(!parts[0] && parts.at(-1)) {
          own.forEach((tag,i)=>entries.push({threadId:tag.id,text:parts[i+1],tag,group:false}));
        } else if(parts[0] && !parts.at(-1)) {
          own.forEach((tag,i)=>entries.push({threadId:tag.id,text:parts[i],tag,group:false}));
        } else errors.push("Can't tell which text goes to which thread. Put each thread on its own line.");
      }
      slices.push(...entries);lines.push({text:line,tags:own,entries});offset+=line.length+1;
    }
    return {shared:'',slices,duplicates:[...duplicates],unresolved,errors,hasTags:tags.length>0,tags,lines};
  };

  // Final per-thread outgoing text & routing before Send
  const computeMultiPlan = () => {
    const draft = state.multiDraft || '';
    const parsed = parseThreadSlices(draft);
    const refs=new Set(attachmentRefs(draft));
    for(const att of state.multiAttachments)state.multiAttachmentCache.set(att.id,att);
    state.multiAttachments=[...refs].map(id=>state.multiAttachmentCache.get(id)).filter(Boolean);
    for(const att of state.multiAttachments)att.dest=new Set(parsed.slices.filter(s=>attachmentRefs(s.text).includes(att.id)).map(s=>s.threadId));
    if(attachmentRefs(draft).some(id=>!state.multiAttachments.some(a=>a.id===id)))parsed.errors.push('Missing attachment — remove its reference or attach it again.');
    if(state.multiTagged && draft.trim() && !parsed.hasTags)parsed.errors.push('Add a #thread tag to say where this text goes.');
    // Selected set = multiSelected plus any tagged threads
    const sel = new Set(parsed.hasTags ? [] : (state.multiSelected ? [...state.multiSelected] : []));
    for (const s of parsed.slices) sel.add(s.threadId);
    for (const t of parsed.tags) sel.add(t.id);
    const ids = [...sel];
    // duplicate detection
    const dupIds = parsed.duplicates;
    const plans = [];
    for (const id of ids) {
      const thr = T(id); if (!thr) continue;
      const ov = state.multiOverrides.get(id) || null;
      const entries=parsed.slices.filter(s=>s.threadId===id);
      const commands=entries.filter(s=>/^\s*\/\S/.test(s.text));
      const specific=entries.filter(s=>!s.group && !/^\s*\/\S/.test(s.text) && s.text.trim());
      const rawSlice=parsed.hasTags ? (commands.length ? commands.map(s=>s.text).join('\n\n') : entries.map(s=>s.text).filter(Boolean).join('\n\n')).trim() : draft;
      const isCommand=commands.length>0 || /^\s*\/\S/.test(rawSlice);
      const outgoing=readableAttachments(rawSlice);
      const explicitForRec=isCommand?[]:explicitMentions(outgoing);
      const rec=recipientFor(thr,explicitForRec,explicitForRec.length?null:ov);
      const isDup = dupIds.includes(id);
      const noText = !outgoing.trim() || (parsed.hasTags && !parsed.slices.some((s)=>s.threadId===id));
      const commandBlocked = isCommand && (rawSlice.trim() !== '/compact' || specific.length>0);
      plans.push({ id, thread: thr, rawSlice, outgoing, isCommand, rec, isDup, noText, commandBlocked });
    }
    return { parsed, ids, plans, dupIds };
  };

  const syncRoutes = () => {
    const plan = hasMulti() ? computeMultiPlan() : null;
    const explicit = plan ? [] : (hasMulti() ? explicitMentions(state.multiDraft) : []);
    for (const [id, p] of panes) {
      const head = $('.pane-head', p); if (!head) continue;
      let tag = $('.mk-route', head);
      const on = hasMulti() && state.multiSelected && state.multiSelected.has(id);
      if (!on) { if (tag) { tag.remove(); fitHead(head); } continue; }
      const thr = T(id); if (!thr) continue;
      const ov = state.multiOverrides.get(id) || null;
      const sliceInfo = plan ? plan.plans.find((pp) => pp.id === id) : null;
      const rec = sliceInfo ? sliceInfo.rec : recipientFor(thr, explicit, ov);
      const none = !members(thr).length;
      const dup = sliceInfo && sliceInfo.isDup;
      let text, bad;
      if (dup) { text = 'dup tag'; bad = true; }
      else if (sliceInfo?.isCommand) { text = '/ command'; bad = sliceInfo.commandBlocked; }
      else if (none) { text = 'no agents'; bad = true; }
      else if (rec.missing.length) { text = `no @${rec.missing[0]}`; bad = true; }
      else {
        const who = rec.agent || lastBotName(thr) || '?';
        text = ov ? `→ ${who} (override)` : `→ ${who}`;
        bad = false;
      }
      if (!tag) { tag = document.createElement('button'); tag.type = 'button'; tag.className = 'mk-route'; tag.addEventListener('click', (e) => { e.stopPropagation(); openAgentMenu(id, tag); }); $('.pane-title', head).after(tag); }
      if (tag.tagName === 'SPAN') { // migrate old span to button
        const nb = document.createElement('button'); nb.type='button'; nb.className=tag.className; nb.addEventListener('click',(e)=>{e.stopPropagation(); openAgentMenu(id, nb);}); tag.replaceWith(nb); tag=nb;
      }
      if (tag.textContent !== text) tag.textContent = text;
      tag.disabled=!!sliceInfo?.isCommand || state.multiPending.size>0;
      tag.classList.toggle('mk-bad', !!bad);
      tag.title = none ? 'This thread has no agents yet' : rec.missing.length ? `@${rec.missing.join(', @')} isn't in this thread · click to choose` : `Your message goes to ${rec.agent || lastBotName(thr)} here · click to choose agent`;
      fitHead(head);
    }
  };
  const syncMultiOutlines = () => {
    for (const [id, p] of panes) p.classList.toggle('mk-multi-selected', hasMulti() && state.multiSelected.has(id));
    syncRoutes();
  };
  const clearMulti = (keepDraft) => {
    state.multiSelected = null;
    state.multiTagged = false;
    if (!keepDraft && !state.multiPending.size && !state.multiDraft.trim() && !state.multiAttachments.length) { state.multiOverrides = new Map(); state.multiResults = new Map(); }
    for (const [id, p] of panes) p.classList.remove('mk-multi-selected', 'mk-multi-missing');
    syncRoutes();
    closeAgentMenu(); closeAtPicker();
    const sh = document.getElementById('mk-shared');
    if (sh) sh.classList.remove('mk-multi');
  };
  const syncSelectionFromDraft = () => {
    const parsed=parseThreadSlices(state.multiDraft);
    state.multiSelected=new Set(parsed.tags.map(t=>t.id).filter(id=>T(id)));
    state.multiTagged=true;
    for(const att of state.multiAttachments)for(const id of att.dest)if(!state.multiSelected.has(id))att.dest.delete(id);
  };
  const removeThreadFromDraft = (id) => {
    const before=state.multiDraft;
    const parsed=parseThreadSlices(before);
    const lines=parsed.lines.map(line=>{
      if(!line.tags.some(t=>t.id===id))return line.text;
      if(line.entries.length && !parsed.errors.length) {
        const remaining=line.entries.filter(e=>e.threadId!==id);
        if(!remaining.length)return '';
        if(remaining.every(e=>e.group))return remaining.map(e=>threadToken(e.threadId)).join(' ')+' '+remaining[0].text;
        return remaining.map(e=>threadToken(e.threadId)+' '+e.text).join('\n');
      }
      // An ambiguous line has no safe ownership: preserve it until the user edits it.
      return line.text;
    });
    const after=lines.filter(Boolean).join('\n');
    if(after===before){toast('Resolve the ambiguous line before removing a destination.');return;}
    state.multiDraft=after;
    state.multiUndo={draft:before,after,attachments:state.multiAttachments.map(a=>({id:a.id,dest:[...a.dest]}))};
    syncSelectionFromDraft();
  };
  const toggleMulti = (id) => {
    if(isSyn(id) || state.multiPending.size)return;
    if(!state.multiSelected) {
      state.multiSelected=new Set();
      if(!state.multiDraft.trim())state.multiDraft=threadToken(state.selected)+' ';
    }
    if(parseThreadSlices(state.multiDraft).tags.some(t=>t.id===id))removeThreadFromDraft(id);
    else {
      state.multiDraft=state.multiDraft+'\n'+threadToken(id)+' ';
      state.multiUndo=null;
      syncSelectionFromDraft();
    }
    syncMultiOutlines();renderComposer();renderSidebar();schedule();
    if(!state.multiDraft.replace(/⟦thread:[^⟧]*⟧/g,'').trim())syncRichEditor(true,parseThreadSlices(state.multiDraft).tags[0]?.len+1);
  };
  // Agent dropdown
  const closeAgentMenu = () => {
    if (state.multiAgentMenu && state.multiAgentMenu.el) state.multiAgentMenu.el.remove();
    state.multiAgentMenu = null;
  };
  const openAgentMenu = (threadId, anchor) => {
    closeAgentMenu();
    const thr = T(threadId); if (!thr) return;
    const agents = agentsInThread(thr);
    if (!agents.length) { toast('No agents in this thread'); return; }
    const el = document.createElement('div');
    el.className = 'mk-agent-menu deck-menu';
    el.setAttribute('role','menu');
    for (const name of agents) {
      const b = document.createElement('button'); b.type='button'; b.setAttribute('role','menuitemradio');
      const route = computeMultiPlan().plans.find((p)=>p.id===threadId);
      const on = (route?.rec.agent || lastBotName(thr) || '').toLowerCase() === name.toLowerCase();
      b.setAttribute('aria-checked', String(on));
      const lb = document.createElement('span'); lb.className='label'; lb.textContent = name;
      const ov = state.multiOverrides.get(threadId);
      if (ov && ov.toLowerCase()===name.toLowerCase()) { const note = document.createElement('span'); note.className='keys'; note.textContent='override'; b.append(lb,note); }
      else b.append(lb);
      if (on) { const ck=document.createElement('span'); ck.className='keys'; ck.textContent='✓'; b.append(ck); }
      b.addEventListener('click', () => {
        state.multiOverrides.set(threadId, name);
        closeAgentMenu(); renderComposer(); syncRoutes();
      });
      el.append(b);
    }
    const sep = document.createElement('span'); sep.className='pane-menu-sep'; sep.setAttribute('role','separator'); el.append(sep);
    const clear = document.createElement('button'); clear.type='button'; clear.setAttribute('role','menuitem'); const lb=document.createElement('span'); lb.className='label'; lb.textContent='Use last @'; clear.append(lb);
    clear.addEventListener('click', () => { state.multiOverrides.delete(threadId); closeAgentMenu(); renderComposer(); syncRoutes(); });
    el.append(clear);
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    el.style.position='fixed'; el.style.left = Math.max(8, Math.min(r.left, innerWidth-el.offsetWidth-8))+'px'; el.style.top = Math.max(8, Math.min(r.bottom+4, innerHeight-el.offsetHeight-8))+'px';
    state.multiAgentMenu = { threadId, el, anchor };
    el.addEventListener('keydown',(e)=>{ const buttons=[...el.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Escape'){e.stopPropagation();closeAgentMenu();anchor.focus();} });
    el.querySelector('button').focus();
  };
  // Separate # thread and @ agent pickers, sharing keyboard behavior.
  const closeAtPicker = () => {
    if (state.multiPicker && state.multiPicker.el) state.multiPicker.el.remove();
    state.multiPicker = null;
  };
  const openAtPicker = (filter, trigger) => {
    closeAtPicker();
    const q = (filter||'').toLowerCase();
    const all = allThreads().filter((t)=>!isSyn(t.id));
    const fuzzy = (text, query) => { let i=0; for (const c of text.toLowerCase()) if(c===query[i]) i++; return i===query.length; };
    const selectedIds = new Set(multiIds());
    const caret=ui.input.selectionStart??ui.input.value.length;
    const lineStart=ui.input.value.lastIndexOf('\n',caret-1)+1;
    const lineEnd=ui.input.value.indexOf('\n',caret);
    const taggedIds = new Set(parseThreadSlices(ui.input.value.slice(lineStart,lineEnd<0?undefined:lineEnd)).tags.map(tag=>tag.id));
    const selectedMatches = trigger === '#' ? all.filter((t)=>selectedIds.has(t.id) && (!q || fuzzy(t.title,q))) : [];
    const otherMatches = trigger === '#' && q ? all.filter((t)=>!selectedIds.has(t.id) && fuzzy(t.title,q)).slice(0,8) : [];
    if (!state.multiCollapsed) { state.multiCollapsed=true; renderComposer(); }
    closeAgentMenu();
    // agents from selected threads + all
    const agentPool = new Map();
    for (const t of (state.multiSelected ? [...state.multiSelected].map((id)=>T(id)).filter(Boolean) : [])) for (const m of members(t)) agentPool.set(m.name.toLowerCase(), m.name);
    for (const b of Object.values(BOTS)) if (!agentPool.has(b.name.toLowerCase())) agentPool.set(b.name.toLowerCase(), b.name);
    const agentMatches = trigger === '@' ? [...agentPool.values()].filter((n)=>!q || n.toLowerCase().includes(q)).slice(0,8) : [];
    if (!selectedMatches.length && !otherMatches.length && !agentMatches.length) return;
    const el = document.createElement('div'); el.className='mk-at-picker deck-menu'; el.setAttribute('role','listbox'); el.setAttribute('aria-label',trigger === '#' ? 'Threads' : 'Agents');
    const addSec = (label, items, kind) => {
      if (!items.length) return;
      const h=document.createElement('span'); h.className='mk-menu-head'; h.textContent=label; el.append(h);
      for (const it of items) {
        const b=document.createElement('button'); b.type='button'; b.setAttribute('role','option');
        const lb=document.createElement('span'); lb.className='label';
        lb.textContent = kind==='thread' ? it.title : it;
        b.append(lb);
        if(kind==='thread') {
          b.dataset.threadId=it.id;
          b.disabled=taggedIds.has(it.id);
          b.setAttribute('aria-disabled',String(b.disabled));
          const detail=document.createElement('span');detail.className='keys';
          const duplicateTitle=all.filter((t)=>t.title===it.title).length>1;
          const memberLabel=members(it).map((m)=>m.name).join(', ');
          detail.textContent=b.disabled ? '✓ tagged' : (it.workspace || 'No project');
          if(duplicateTitle && !b.disabled) detail.textContent+=' · '+memberLabel;
          b.title=it.title+' · '+(it.workspace || 'No project')+(duplicateTitle ? ' · '+memberLabel : '');
          b.append(detail);
        }
        b.addEventListener('click', () => {
          if (kind==='thread') applyThreadPick(it);
          else applyAgentPick(it);
        });
        el.append(b);
      }
    };
    addSec('In this message', selectedMatches, 'thread');
    addSec('Other threads · adds to selection', otherMatches, 'thread');
    addSec('Agents', agentMatches, 'agent');
    document.body.append(el);
    const inp = document.getElementById('mk-input');
    const rr = richEditor && !richEditor.hidden ? richEditor.getBoundingClientRect() : inp ? inp.getBoundingClientRect() : {left:0, bottom:0};
    el.style.position='fixed'; el.style.left = Math.max(8, Math.min(rr.left,innerWidth-el.offsetWidth-8))+'px'; el.style.top = Math.max(8,rr.top-Math.min(280,el.scrollHeight)-4)+'px'; el.style.maxHeight='280px'; el.style.overflow='auto';
    el.addEventListener('mousedown',(e)=>e.preventDefault());
    el.addEventListener('keydown',(e)=>{const buttons=[...el.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Escape'){closeAtPicker();if(richEditor&&!richEditor.hidden)richEditor.focus();else ui.input.focus();}});
    state.multiPicker = { el, filter: q };
  };
  const replacePickerQuery = (insert) => {
    const start = state.multiPicker?.start ?? ui.input.selectionStart;
    const end = state.multiPicker?.end ?? ui.input.selectionEnd;
    const value = ui.input.value.slice(0,start)+insert+' '+ui.input.value.slice(end);
    ui.input.value=value;
    ui.input.setSelectionRange(start+insert.length+1,start+insert.length+1);
    return start+insert.length+1;
  };
  const applyThreadPick = (threadObj) => {
    const caretAt=ui.input.selectionStart??ui.input.value.length;
    const lineStart=ui.input.value.lastIndexOf('\n',caretAt-1)+1;const lineEnd=ui.input.value.indexOf('\n',caretAt);
    if(parseThreadSlices(ui.input.value.slice(lineStart,lineEnd<0?undefined:lineEnd)).tags.some(tag=>tag.id===threadObj.id)) { toast('This thread is already tagged in this message.'); return; }
    if(state.multiPending.size) { closeAtPicker(); toast('Retry or discard the failed batch before creating another tagged draft. Your single-thread draft is kept.'); renderComposer(); return; }
    if (!state.multiSelected) {
      state.multiDraft=ui.input.value;
      state.drafts.set(state.selected,'');
      state.multiSelected=new Set([state.selected]);
    }
    state.multiSelected.add(threadObj.id);
    state.multiTagged=true;
    const caret=replacePickerQuery(threadToken(threadObj.id));
    state.multiDraft=ui.input.value;
    syncSelectionFromDraft();
    closeAtPicker(); renderComposer(); syncMultiOutlines(); syncRichEditor(true,caret);
  };
  const applyAgentPick = (agentName) => {
    const caret=replacePickerQuery('@'+agentName.toLowerCase());
    if(hasMulti()) state.multiDraft=ui.input.value; else state.drafts.set(state.selected,ui.input.value);
    closeAtPicker(); renderComposer(); syncRichEditor(true,caret);
    if(!richEditor || richEditor.hidden) ui.input.focus();
  };
  const onComposerAtTrigger = (text, caret) => {
    // A boundary avoids treating email addresses or inline hashes as triggers.
    const m = text.slice(0, caret).match(/(?:^|[\s(])([@#])([A-Za-z0-9 _-]{0,24})$/);
    if (m) { openAtPicker(m[2],m[1]); if(state.multiPicker) { state.multiPicker.start=caret-m[2].length-1; state.multiPicker.end=caret; } return true; }
    closeAtPicker(); return false;
  };

  // ---------- panes ----------
  const buildPane = (thread) => {
    const pane = tpl('mk-tpl-pane');
    pane.dataset.id = thread.id;
    const syn = !!thread.synthetic;
    pane.classList.toggle('mk-syn', syn);
    const ws = syn ? 'scale test' : 'apex-deck';
    const head = $('.pane-head', pane);
    head.title = syn ? `${ws} · Double-click to fill the canvas` : `${ws} · Drag to move · Double-click to fill the canvas`;
    $('.pane-ws', head).title = ws;
    $('.pane-ws .nm', head).textContent = ws;
    $('.pane-ws .nm-short', head).textContent = ws[0];
    const title = $('.pane-title', head);
    setTitleText(title, thread.title); title.title = thread.title; title.setAttribute('aria-label', `Rename ${thread.title}`);
    if (syn) { const tag = document.createElement('span'); tag.className = 'mk-syn-tag'; tag.textContent = 'synthetic'; tag.title = 'Made up for the scale test'; title.after(tag); }
    $('.pane-folder', head).textContent = botCount(agentTotal(thread));
    $('.chat', pane).style.setProperty('--composer-h', '0px');
    const [maxBtn, moreBtn, closeBtn] = [$('button[aria-label="Maximize pane"]', head), $('.pane-menu-wrap button', head), $('button[aria-label^="Close"]', head)];
    moreBtn.setAttribute('aria-label', `More actions for ${thread.title}`);
    closeBtn.setAttribute('aria-label', `Close ${thread.title}`);
    maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFull(thread.id); });
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(thread.id, moreBtn); });
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closePane(thread.id); });
    head.addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; toggleFull(thread.id); });
    head.addEventListener('pointerdown', (e) => {
      // ⌘-click / Ctrl-click on the title bar toggles multi-selection, never drags and never triggers the pane's select handler
      if ((e.metaKey || e.ctrlKey) && e.button === 0 && !e.target.closest('button')) {
        e.preventDefault(); e.stopPropagation(); toggleMulti(thread.id); return;
      }
      startDrag(e, thread.id);
    });
    // Title bar click when not dragging also respects multi
    head.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); e.stopPropagation(); }
    });
    pane.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Don't hijack links, text selection handles, buttons, inputs
      if (e.target.closest('a, button, input, textarea, select, .md-code-actions, .chip, .quick-add-wrap')) return;
      // ⌘-click only on title bar (handled above) or empty pane space – the transcript background or .empty landing
      const isEmptySpace = e.target.closest('.transcript') && !e.target.closest('.message-row, .bot-row, .human-row, .empty-copy h3, .empty-copy p, .empty-emblem');
      const onTitle = e.target.closest('.pane-head');
      const wantMulti = (e.metaKey || e.ctrlKey) && (onTitle || isEmptySpace || e.target.classList.contains('transcript') || e.target.classList.contains('chat-body'));
      if (wantMulti) { e.preventDefault(); e.stopPropagation(); toggleMulti(thread.id); return; }
      // Plain click selects single
      select(thread.id);
    }, true);
    // Keep multi outline after mount
    if (hasMulti() && state.multiSelected.has(thread.id)) pane.classList.add('mk-multi-selected');
    const tile = document.createElement('div'); tile.className = 'mk-tile-body';
    $('.pane-body', pane).append(tile);
    fillTranscript(pane, thread);
    return pane;
  };
  // A thread with no messages shows Deck's own landing; with no agents it asks for some.
  const landingNode = (thread) => {
    const empty = tpl('mk-tpl-empty');
    const nBots = members(thread).length;
    $('.pick-name', empty).textContent = 'apex-deck';
    $('.pick-name', empty).addEventListener('click', () => toast('Mockup: the project picker is not wired'));
    $('.where', empty).textContent = 'On This Mac · apex-deck';
    const say = $('.empty-copy > p:not(.where)', empty);
    const add = $('.empty-copy > button.primary', empty);
    if (nBots) { say.textContent = 'Type a message below. Use @name to pick who answers, or @all for everyone.'; add.remove(); }
    else add.addEventListener('click', (e) => { e.stopPropagation(); openAdd(thread.id); });
    // Once agents are picked but nothing is sent, they fill the pane's
    // background (replacing the rain texture) until the first prompt.
    if (nBots) {
      const tex = $('.landing-texture-wrap', empty); if (tex) tex.remove();
      const cv = document.createElement('canvas'); cv.className = 'mk-field'; cv.setAttribute('aria-hidden', 'true');
      cv._src = agentSource(thread); cv._tid = thread.id;
      empty.prepend(cv);
      empty.classList.add('mk-has-cast');
    }
    return empty;
  };
  const fillTranscript = (pane, thread) => {
    const tr = $('.transcript', pane);
    const msgs = allMessages(thread);
    $('.chat', pane).classList.toggle('thread-landing', !msgs.length);
    const rows = msgs.length ? msgs.map((m) => messageNode(thread, m)) : [landingNode(thread)];
    if (thread.synthetic && msgs.length) { const note = document.createElement('p'); note.className = 'mk-syn-note'; note.textContent = 'Synthetic thread, made up on demand for the scale test. Nothing in it is real or saved.'; rows.unshift(note); }
    tr.replaceChildren(...rows);
    $('.pane-folder', pane).textContent = botCount(agentTotal(thread));
    const last = msgs.at(-1);
    const tile = $('.mk-tile-body', pane);
    tile.replaceChildren();
    if (last) { const b = document.createElement('b'); b.textContent = last.speaker + ': '; tile.append(b, last.text.replace(/[*`#]/g, '').slice(0, 220)); }
    else if (!members(thread).length) {
      const b = document.createElement('b'); b.textContent = 'No agents yet. ';
      const add = document.createElement('button'); add.type = 'button'; add.className = 'primary mk-tile-add'; add.textContent = '+ Add agents';
      add.addEventListener('click', (e) => { e.stopPropagation(); openAdd(thread.id); });
      tile.append(b, 'Add some to start.', add);
    } else {
      tile.textContent = 'No messages yet · ';
      const names = document.createElement('b'); names.textContent = members(thread).map((m) => m.name).join(', ');
      tile.append(names);
    }
    // Like Deck, a thread opens on its latest message. (The transcript is the
    // element that scrolls; the old mockup scrolled .chat-body, which never moved.)
    state.scrolls.set(thread.id, { pinned: true });
    if (pane.isConnected) tr.scrollTop = tr.scrollHeight;
  };
  const paneOf = (id) => { if (!panes.has(id)) panes.set(id, buildPane(T(id))); return panes.get(id); };

  // ---------- reading place: each thread keeps where you were in it ----------
  // Saved as "the message at the top and how far into it", so a pane can change
  // width (text rewraps), go off screen or turn into a card and come back to the
  // same line. A pane scrolled to the bottom stays on the latest message.
  const scroller = (p) => $('.transcript', p);
  const anchorOf = (p) => {
    if (p.classList.contains('mk-tile')) return p._tileAnchor || null;
    const tr = scroller(p); if (!tr || !tr.isConnected || tr.clientHeight < 2) return null;
    if (tr.scrollHeight - tr.clientHeight - tr.scrollTop < 4) return { pinned: true };
    const top = tr.getBoundingClientRect().top; const kids = tr.children;
    for (let i = 0; i < kids.length; i++) { const r = kids[i].getBoundingClientRect(); if (r.bottom > top + 1) return { pinned: false, i, off: top - r.top }; }
    return { pinned: true };
  };
  const applyAnchor = (p, a) => {
    const tr = scroller(p); if (!tr || !a || tr.clientHeight < 2) return;
    if (a.pinned) { tr.scrollTop = tr.scrollHeight; return; }
    const row = tr.children[a.i]; if (!row) { tr.scrollTop = tr.scrollHeight; return; }
    tr.scrollTop += row.getBoundingClientRect().top - tr.getBoundingClientRect().top + a.off;
  };
  const saveScroll = (id, p) => { const a = anchorOf(p); if (a) state.scrolls.set(id, a); };

  // ---------- layout: the pinned focus pane, and the map beside it ----------
  const GAP = 8; const PAD = 4; const MIN_COL = 280; const MIN_W = 200; const MIN_FOCUS = 320; const MIN_SIDE = 260;
  const ROW_H = 200;
  const GROUP_AT = 200;
  // Live (real title bar with ×) down to 120×56: a 28px bar plus one line.
  const LIVE_W = 120; const LIVE_H = 56;
  const LIVE_CAP = 48;
  const Z_MAX = 2; const HUD_CLEAR = 0; const BAR_H = 0;
  const B = 10; const FAN = B * B; const TOP_MAX = 400;
  const LEAF_W = 300; const LEAF_H = 210; // a pane in a nested map, at 100%
  const AGG_PX = 4;             // contents smaller than this on screen draw as one block
  const reduced = motionOff();
  const mainRegion = document.createElement('div'); mainRegion.className = 'mk-region mk-main';
  const mapEl = document.createElement('div'); mapEl.className = 'mk-map'; mapEl.tabIndex = 0;
  mapEl.setAttribute('role', 'region'); mapEl.setAttribute('aria-roledescription', 'thread map');
  mapEl.setAttribute('aria-label', 'Thread map. Scroll to move. Pinch, or hold Ctrl and scroll, to zoom. Keys: arrows move, plus and minus zoom, 0 resets to 100%, Shift+1 fits open threads, Backspace goes back.');
  const mapCv = document.createElement('canvas'); mapCv.className = 'mk-map-cv'; mapCv.setAttribute('aria-hidden', 'true');
  const liveLayer = document.createElement('div'); liveLayer.className = 'mk-live';
  const tip = document.createElement('div'); tip.className = 'mk-tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip');
  const split = document.createElement('div'); split.className = 'mk-split'; split.setAttribute('role', 'separator'); split.setAttribute('aria-orientation', 'vertical'); split.tabIndex = 0;
  split.title = 'Drag to resize · Double-click to reset · Alt+Shift+←/→';
  const slot = document.createElement('div'); slot.className = 'mk-slot';
  // Drawn cards and blocks are also listed as buttons (visually hidden), so a
  // keyboard, a screen reader or an automation tool can zoom to them too.
  const axList = document.createElement('div'); axList.className = 'mk-ax'; axList.setAttribute('role', 'list'); axList.setAttribute('aria-label', 'Threads drawn on the map. Each button zooms to it.');
  mapEl.append(mapCv, liveLayer, tip, axList);
  ui.grid.append(mainRegion, mapEl, split);

  let fr = null; let world = null; let cam = { z: 1, x: 0, y: 0 };
  const openIds = () => state.order.filter((id) => !state.closed.has(id));
  const fracs = (key, n) => {
    const f = state.colFracs.get(key);
    return f && f.length === n ? f : Array.from({ length: n }, () => 1 / n);
  };
  // Where the pinned pane (Focus left/right, or full screen) and the map sit.
  const frameFor = (ids) => {
    const W = ui.grid.clientWidth - 2 * PAD; const H = ui.grid.clientHeight - 2 * PAD;
    const f = { W, H, main: null, map: null, split: null, mainId: null, mapIds: ids };
    if (state.full) { f.main = { x: PAD, y: PAD, w: W, h: H }; f.mainId = state.full; f.mapIds = []; return f; }
    if (state.layout !== 'grid' && ids.length > 1 && W >= MIN_FOCUS + MIN_SIDE + GAP) {
      const fw = Math.round(clamp((W - GAP) * state.focusFrac, MIN_FOCUS, W - GAP - MIN_SIDE));
      const right = state.layout === 'right';
      f.main = { x: right ? PAD + W - fw : PAD, y: PAD, w: fw, h: H };
      f.mainId = ids[0]; f.mapIds = ids.slice(1);
      f.map = { x: right ? PAD : PAD + fw + GAP, y: PAD, w: W - fw - GAP, h: H };
      f.split = right ? f.main.x - GAP : PAD + fw;
    } else f.map = { x: PAD, y: PAD, w: W, h: H };
    return f;
  };
  // The map's world, laid out at 100%. Up to GROUP_AT threads it is the same
  // column grid as before. Past that, threads nest in 10 × 10 blocks.
  const synCount = () => Math.max(0, state.scaleThreads - state.synClosed.length);
  const makeWorld = (area, ids) => {
    const n = ids.length + (state.full ? 0 : synCount());
    return n > GROUP_AT ? groupWorld(area, ids, n) : flatWorld(area, ids, n);
  };
  // Fill rule: zoom = how many panes are on screen, never a camera scale.
  // Every zoom level is a whole number of columns × visible rows that fills the
  // area exactly, so there are no margins and no cut-off panes. Panes keep a
  // window-like shape; the rest of the threads scroll below by whole rows.
  const PANE_AR = 1.4;
  const flatLevels = (n, W, H) => {
    const cands = [];
    for (let c = 1; c <= Math.min(n, 10); c++) {
      const w = (W - (c - 1) * GAP) / c; if (c > 1 && w < 60) break;
      const rt = Math.ceil(n / c);
      for (let r = 1; r <= rt; r++) {
        const h = (H - (r - 1) * GAP) / r; if (r > 1 && h < 36) break;
        cands.push({ c, r, w, h, shown: Math.min(n, c * r), s: Math.abs(Math.log((w / h) / PANE_AR)) });
      }
    }
    // Start from the best "every thread fits" layout, then keep zooming in by
    // showing fewer panes. Columns never come back (2 → 3 → 2 reads as a jump),
    // each level's panes are bigger than the last, and odd shapes are skipped
    // except for the last level, one pane filling the area.
    const fits = cands.filter((L) => L.shown === n).sort((x, y) => x.s - y.s);
    const out = [fits[0]];
    const shownVals = [...new Set(cands.map((L) => L.shown))].filter((v) => v < n).sort((x, y) => y - x);
    for (const v of shownVals) {
      const prev = out.at(-1);
      const pick = cands.filter((L) => L.shown === v && L.c <= prev.c && L.w * L.h > prev.w * prev.h + 1 && (v === 1 || L.s <= Math.log(2)))
        .sort((x, y) => x.s - y.s)[0];
      if (pick) out.push(pick);
    }
    if (out.at(-1).shown !== 1) out.push(cands.find((L) => L.c === 1 && L.r === 1));
    return out;
  };
  // 100% is the comfortable layout from before: the most panes on screen that
  // are still at least MIN_COL wide (or the full width) and ROW_H tall.
  const defaultLevel = (levels, W) => {
    const minW = Math.min(MIN_COL, W);
    let d = levels.findIndex((L) => L.w >= minW - 0.5 && L.h >= ROW_H);
    if (d < 0) d = levels.length - 1;
    return d;
  };
  const levelFor = (levels, d, z) => {
    const target = levels[d].shown / z; let bi = 0; let bs = Infinity;
    levels.forEach((L, i) => { const s = Math.abs(Math.log(L.shown / target)); if (s < bs - 1e-9) { bs = s; bi = i; } });
    return bi;
  };
  // flatZoom 1 = the default level; zooming out can reach "every thread fits",
  // zooming in can reach one pane filling the area.
  const flatZoomRange = (levels, d) => [levels[d].shown / levels[0].shown, levels[d].shown / levels.at(-1).shown];
  // Even grid › Horizontal / Vertical: bands instead of a grid. Horizontal is
  // full-width rows stacked and scrolling down; Vertical is full-height columns
  // side by side, scrolling sideways. Zoom sets how many bands are on screen,
  // from as many as stay readable down to one band filling the area.
  const BAND_MIN = { h: 56, v: 120 };
  const bandLevels = (n, W, H, dir) => {
    const span = dir === 'v' ? W : H; const out = [];
    const most = Math.max(1, Math.min(n, Math.floor((span + GAP) / (BAND_MIN[dir] + GAP))));
    for (let k = most; k >= 1; k--) {
      const size = (span - (k - 1) * GAP) / k;
      out.push(dir === 'v' ? { c: k, r: 1, w: size, h: H, shown: k } : { c: 1, r: k, w: W, h: size, shown: k });
    }
    return out;
  };
  const bandDir = () => (state.layout === 'grid' && (state.gridDir === 'h' || state.gridDir === 'v') ? state.gridDir : null);
  const flatWorld = (area, ids, n) => {
    const w = { kind: 'flat', n, nReal: ids.length, ids, W: area.w, H: 0, C: 1, rows: 0, xs: [], widths: [], rowH: ROW_H, rv: 1, key: '', levels: [], li: 0, d: 0, band: null };
    if (!n) return w;
    const band = bandDir();
    const levels = band ? bandLevels(n, area.w, area.h, band) : flatLevels(n, area.w, area.h); const d = defaultLevel(levels, area.w);
    const [lo, hi] = flatZoomRange(levels, d);
    state.flatZoom = clamp(state.flatZoom || 1, lo, hi);
    const li = levelFor(levels, d, state.flatZoom); const L = levels[li];
    const C = L.c; const rows = Math.ceil(n / C); const rv = Math.min(rows, L.r);
    const colW = (area.w - (C - 1) * GAP) / C; const rowH = (area.h - (rv - 1) * GAP) / rv;
    const xs = []; const widths = [];
    for (let i = 0; i < C; i++) { xs[i] = i * (colW + GAP); widths[i] = colW; }
    const lastCount = n - (rows - 1) * C;
    if (band === 'v') {
      // One row of full-height columns; the camera scrolls sideways.
      const cv = L.c; const colWv = (area.w - (cv - 1) * GAP) / cv;
      return Object.assign(w, { band, C: n, rows: 1, rv: 1, cv, colW: colWv, rowH: area.h, xs: [], widths: [], cols: [], W: n * colWv + (n - 1) * GAP, H: area.h, lastCount: n, levels, li, d, key: `band-v-${cv}` });
    }
    return Object.assign(w, { band, C, rows, rv, rowH, xs, widths, cols: band ? [] : xs.slice(1).map((x) => x - GAP), W: area.w, H: rows * rowH + (rows - 1) * GAP, lastCount, levels, li, d, key: band ? `band-h-${rv}` : `${C}x${rv}` });
  };
  const groupWorld = (area, ids, n) => {
    const L = [{ w: LEAF_W, h: LEAF_H, gap: GAP, padX: 0, padTop: 0, span: 1 }];
    // Same shape at every level: a block is 10 × 10 of the level below, with a
    // header strip for its label and a gap that grows with it.
    while (L.length === 1 || Math.ceil(n / L[L.length - 1].span) > TOP_MAX) {
      const c = L[L.length - 1];
      const iw = B * c.w + (B - 1) * c.gap; const ih = B * c.h + (B - 1) * c.gap;
      const padX = Math.round(iw * 0.03); const padTop = Math.round(iw * 0.07);
      const w = iw + 2 * padX; const h = ih + padTop + padX;
      L.push({ w, h, gap: Math.round(w * 0.06), padX, padTop, span: c.span * FAN });
    }
    const m = L.length - 1; const top = L[m]; const K = Math.ceil(n / top.span);
    const aspect = (area.w || 1) / (area.h || 1);
    const C = clamp(Math.round(Math.sqrt(K * aspect * top.h / top.w)), 1, K); const R = Math.ceil(K / C);
    return { kind: 'group', n, nReal: ids.length, ids, L, m, K, C, R, W: C * top.w + (C - 1) * top.gap, H: R * top.h + (R - 1) * top.gap };
  };
  const flatRect = (w, i) => {
    if (w.band === 'v') return { x: i * (w.colW + GAP), y: 0, w: w.colW, h: w.H };
    const row = Math.floor(i / w.C); const col = i % w.C;
    if (row === w.rows - 1 && w.lastCount !== w.C) {
      // A short last row widens to fill, so odd counts leave no hole.
      const m = w.lastCount; const ww = (w.W - (m - 1) * GAP) / m;
      return { x: col * (ww + GAP), y: row * (w.rowH + GAP), w: ww, h: w.rowH };
    }
    return { x: w.xs[col], y: row * (w.rowH + GAP), w: w.widths[col], h: w.rowH };
  };
  const posAt = (w, i) => {
    if (w.kind === 'flat') {
      const p = flatRect(w, i); const tw = w.tw;
      if (!tw || !tw.from[i]) return p;
      const u = (performance.now() - tw.t0) / tw.ms;
      if (u >= 1) { w.tw = null; return p; }
      const e = 1 - Math.pow(1 - u, 3); const f = tw.from[i];
      return { x: f.x + (p.x - f.x) * e, y: f.y + (p.y - f.y) * e, w: f.w + (p.w - f.w) * e, h: f.h + (p.h - f.h) * e };
    }
    const top = w.L[w.m]; const t = Math.floor(i / top.span); let rem = i - t * top.span;
    let x = (t % w.C) * (top.w + top.gap); let y = Math.floor(t / w.C) * (top.h + top.gap);
    for (let k = w.m; k >= 1; k--) {
      const s = w.L[k]; const c = w.L[k - 1]; const ci = Math.floor(rem / c.span); rem -= ci * c.span;
      x += s.padX + (ci % B) * (c.w + c.gap); y += s.padTop + Math.floor(ci / B) * (c.h + c.gap);
    }
    return { x, y, w: LEAF_W, h: LEAF_H };
  };
  // World index ↔ thread id. Real threads come first, then synthetic ones.
  const synAt = (j) => { let s = j; for (const c of state.synClosed) { if (c <= s) s++; else break; } return s; };
  const idAt = (i) => i < world.nReal ? world.ids[i] : SYN + synAt(i - world.nReal);
  const indexOf = (id) => {
    const r = world.ids.indexOf(id); if (r >= 0) return r;
    if (!isSyn(id) || state.full) return -1;
    const s = synNum(id); if (!(s < state.scaleThreads) || state.synClosed.includes(s)) return -1;
    return world.nReal + s - state.synClosed.filter((c) => c < s).length;
  };
  // Visit what is on screen: leaves (panes), blocks drawn whole, and frames of
  // blocks whose contents are drawn. Work grows with the screen, not the count.
  const walk = (w, z, v, stats, out) => {
    if (!w.n) return;
    if (w.kind === 'flat') {
      // At most GROUP_AT threads, so checking each one is cheap, and a pane
      // gliding to a new row is never skipped.
      for (let i = 0; i < w.n; i++) {
        const p = posAt(w, i); if (p.x > v.x1 || p.x + p.w < v.x0 || p.y > v.y1 || p.y + p.h < v.y0) continue;
        out.leaf(i, p, 1);
      }
      return;
    }
    const top = w.L[w.m]; const px = top.w + top.gap; const py = top.h + top.gap;
    const c0 = Math.max(0, Math.floor(v.x0 / px)); const c1 = Math.min(w.C - 1, Math.floor(v.x1 / px));
    const r0 = Math.max(0, Math.floor(v.y0 / py)); const r1 = Math.min(w.R - 1, Math.floor(v.y1 / py));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const t = r * w.C + c; if (t >= w.K) continue;
      const first = t * top.span;
      node(w, z, v, stats, out, w.m, c * px, r * py, first, Math.min(top.span, w.n - first), 1);
    }
  };
  const node = (w, z, v, stats, out, k, x, y, first, count, a) => {
    const s = w.L[k];
    if (x > v.x1 || y > v.y1 || x + s.w < v.x0 || y + s.h < v.y0) return;
    if (k === 0) { out.leaf(first, { x, y, w: s.w, h: s.h }, a); return; }
    const c = w.L[k - 1]; const rect = { x, y, w: s.w, h: s.h };
    const t = stats.budget > 0 ? smooth(c.w * z, AGG_PX, AGG_PX * 2.5) : 0;
    if (t < 1) out.block(k, rect, first, count, a * (1 - t));
    if (t <= 0) return;
    out.frame(k, rect, first, count, a * t);
    const px = c.w + c.gap; const py = c.h + c.gap; const ox = x + s.padX; const oy = y + s.padTop;
    const kids = Math.ceil(count / c.span);
    const cx0 = Math.max(0, Math.floor((v.x0 - ox) / px)); const cx1 = Math.min(B - 1, Math.floor((v.x1 - ox) / px));
    const cy0 = Math.max(0, Math.floor((v.y0 - oy) / py)); const cy1 = Math.min(B - 1, Math.floor((v.y1 - oy) / py));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const ci = cy * B + cx; if (ci >= kids) break;
      stats.budget--;
      node(w, z, v, stats, out, k - 1, ox + cx * px, oy + cy * py, first + ci * c.span, Math.min(c.span, count - ci * c.span), a * t);
    }
    if (out.label) out.label(k, rect, first, count, a * t);
  };
  // What is under a point on screen: a pane, or a block (with its contents
  // too small to tell apart, or the pointer in its margin).
  const hitAt = (sx, sy) => {
    if (!world || !world.n) return null;
    const z = cam.z; const wx = cam.x + sx / z; const wy = cam.y + sy / z;
    if (world.kind === 'flat') {
      for (let i = 0; i < world.n; i++) { const p = posAt(world, i); if (wx >= p.x && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h) return { kind: 'leaf', i, r: flatRect(world, i) }; }
      return null;
    }
    const top = world.L[world.m]; const px = top.w + top.gap; const py = top.h + top.gap;
    const c = Math.floor(wx / px); const r = Math.floor(wy / py);
    if (c < 0 || r < 0 || c >= world.C || r >= world.R || r * world.C + c >= world.K) return null;
    let k = world.m; let x = c * px; let y = r * py; let first = (r * world.C + c) * top.span; let count = Math.min(top.span, world.n - first);
    for (;;) {
      const s = world.L[k];
      if (wx < x || wy < y || wx > x + s.w || wy > y + s.h) return null;
      if (k === 0) return { kind: 'leaf', i: first, r: { x, y, w: s.w, h: s.h } };
      const g = { kind: 'group', k, first, count, r: { x, y, w: s.w, h: s.h } };
      const ch = world.L[k - 1]; if (ch.w * z < AGG_PX * 2) return g;
      const cpx = ch.w + ch.gap; const cpy = ch.h + ch.gap; const ox = x + s.padX; const oy = y + s.padTop;
      const cx = Math.floor((wx - ox) / cpx); const cy = Math.floor((wy - oy) / cpy);
      if (cx < 0 || cy < 0 || cx >= B || cy >= B) return g;
      const ci = cy * B + cx; if (ci >= Math.ceil(count / ch.span)) return g;
      const nx = ox + cx * cpx; const ny = oy + cy * cpy;
      if (wx > nx + ch.w || wy > ny + ch.h) return g;
      const nCount = Math.min(ch.span, count - ci * ch.span);
      first += ci * ch.span; count = nCount; x = nx; y = ny; k -= 1;
    }
  };
  // Open blocks around a world point, outermost first (for "where am I").
  const groupChain = (wx, wy) => {
    const chain = []; if (world.kind !== 'group') return chain;
    const z = cam.z; const top = world.L[world.m]; const px = top.w + top.gap; const py = top.h + top.gap;
    const c = Math.floor(wx / px); const r = Math.floor(wy / py);
    if (c < 0 || r < 0 || c >= world.C || r >= world.R || r * world.C + c >= world.K) return chain;
    let k = world.m; let x = c * px; let y = r * py; let first = (r * world.C + c) * top.span; let count = Math.min(top.span, world.n - first);
    while (k >= 1) {
      const s = world.L[k]; const ch = world.L[k - 1];
      if (wx < x || wy < y || wx > x + s.w || wy > y + s.h) break;
      chain.push({ k, first, count, r: { x, y, w: s.w, h: s.h } });
      if (ch.w * z < AGG_PX * 2) break;
      const cpx = ch.w + ch.gap; const cpy = ch.h + ch.gap; const ox = x + s.padX; const oy = y + s.padTop;
      const cx = clamp(Math.floor((wx - ox) / cpx), 0, B - 1); const cy = clamp(Math.floor((wy - oy) / cpy), 0, B - 1);
      const ci = cy * B + cx; if (ci >= Math.ceil(count / ch.span)) break;
      const nCount = Math.min(ch.span, count - ci * ch.span);
      first += ci * ch.span; count = nCount; x = ox + cx * cpx; y = oy + cy * cpy; k -= 1;
    }
    return chain;
  };

  // ---------- camera ----------
  const camKey = () => `${state.layout}|${world ? world.kind : 'flat'}`;
  const viewW = () => (fr && fr.map ? fr.map.w : 1);
  const viewH = () => (fr && fr.map ? fr.map.h : 1);
  const fitZ = () => (world && world.n ? Math.min(viewW() / world.W, viewH() / world.H) : 1);
  const zMin = () => Math.min(0.5, fitZ() * 0.6);
  const clampCam = (c) => {
    c.z = clamp(c.z, zMin(), Z_MAX);
    const vw = viewW() / c.z; const vh = viewH() / c.z;
    if (world && world.kind === 'flat') {
      // Fill rule: the camera never scales or moves sideways. Scrolling is
      // free while it happens; settle() lands it on a whole row afterwards.
      // Vertical bands scroll sideways instead, so the roles swap.
      c.z = 1;
      if (world.band === 'v') { c.y = 0; c.x = clamp(c.x, 0, Math.max(0, world.W - viewW())); } else { c.x = 0; c.y = clamp(c.y, 0, Math.max(0, world.H - viewH())); }
      return c;
    }
    c.x = world.W <= vw ? (world.W - vw) / 2 : clamp(c.x, 0, world.W - vw);
    c.y = world.H <= vh ? (world.H - vh) / 2 : clamp(c.y, 0, world.H - vh);
    return c;
  };
  const loadCam = () => { const k = camKey(); let c = state.cams.get(k); if (!c) { c = { z: 1, x: 0, y: 0 }; state.cams.set(k, c); } cam = c; clampCam(cam); };
  const toScr = (r) => ({ x: (r.x - cam.x) * cam.z, y: (r.y - cam.y) * cam.z, w: r.w * cam.z, h: r.h * cam.z });
  let raf = 0; let moving = 0; let settleT = 0; let anim = null;
  const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; paint(drag && drag.moved ? drag.p : null); }); };
  const touched = () => { moving = performance.now(); clearTimeout(settleT); settleT = setTimeout(settle, 170); };
  // A flat map scrolls along one axis: down through rows, or sideways through
  // Vertical bands. A "line" is one row, or one column of Vertical bands.
  const sideways = (w = world) => !!(w && w.band === 'v');
  const rowStride = (w = world) => (sideways(w) ? w.colW + GAP : w.rowH + GAP);
  const scrollPos = () => (sideways() ? cam.x : cam.y);
  const scrollCam = (pos) => (sideways() ? { z: 1, x: pos, y: 0 } : { z: 1, x: 0, y: pos });
  const maxScroll = () => (sideways() ? Math.max(0, world.W - viewW()) : Math.max(0, world.H - viewH()));
  const snappedY = () => clamp(Math.round(scrollPos() / rowStride()) * rowStride(), 0, maxScroll());
  // When scrolling stops, glide to the nearest whole row so none is cut off.
  const settle = () => {
    moving = 0;
    if (world && world.kind === 'flat' && fr && fr.map && !anim && !pan && Math.abs(snappedY() - scrollPos()) > 0.5) { animateTo(scrollCam(snappedY()), true); return; }
    fitAll(); updateHud(true); syncAx();
  };
  const setCam = (c) => { Object.assign(cam, clampCam({ ...c })); schedule(); touched(); };
  const mapCount = () => (fr ? fr.mapIds.length : 0) + (state.full ? 0 : synCount());
  // Change the zoom level. The pane under (sx, sy) stays on screen at about the
  // same height, and every pane glides from where it was to its new place.
  // act: the active panes (zoom keeps them all on screen while they fit).
  // ptr: the pointer, used once they no longer fit, so zooming carries on
  // toward whatever is under it, down to one pane filling the area.
  let ptrPick = null;
  const setFlatZoom = (z, sx, sy, top, act, ptr) => {
    if (!fr || !fr.map || !world || world.kind !== 'flat' || !world.n) return;
    const old = world; const oldX = cam.x; const oldY = cam.y; const oldSide = sideways(old);
    const under = (x, y) => { const h = hitAt(clamp(x, 0, viewW() - 1), clamp(y, 0, viewH() - 1)); return h && h.kind === 'leaf' ? h.i : -1; };
    // The first pane of the line under a point, in the old layout.
    const rowAnchorAt = (x, y) => clamp(oldSide ? Math.floor((oldX + x) / rowStride(old)) : Math.floor((oldY + y) / rowStride(old)) * old.C, 0, old.n - 1);
    const rowAnchor = (y) => rowAnchorAt(sx, y);
    const hasAct = !!(act && act.length);
    let anchor = hasAct ? act[Math.floor((act.length - 1) / 2)] : under(sx, sy);
    if (anchor < 0) anchor = rowAnchor(sy);
    // What the pointer is over now, before the panes move.
    // While the pointer stays put, keep zooming toward the same pane, even
    // after columns change and slide a neighbour under the pointer.
    const still = ptr && ptrPick && Math.hypot(ptr.sx - ptrPick.sx, ptr.sy - ptrPick.sy) < 4 && ptrPick.i < old.n;
    const ptrAnchor = !ptr ? -1 : still ? ptrPick.i : (() => { const u = under(ptr.sx, ptr.sy); return u >= 0 ? u : rowAnchorAt(ptr.sx, ptr.sy); })();
    state.flatZoom = z;
    const nw = flatWorld(fr.map, fr.mapIds, mapCount());
    if (nw.key === old.key) { if (old.tw) nw.tw = old.tw; world = nw; return; }
    const from = []; for (let i = 0; i < old.n; i++) { const p = posAt(old, i); from[i] = { x: p.x - oldX, y: p.y - oldY, w: p.w, h: p.h }; }
    world = nw;
    // Lines along the scroll axis: rows, or Vertical band columns.
    const side = sideways(nw);
    const rowOf = side ? (i) => i : (i) => Math.floor(i / nw.C);
    const vis = side ? nw.cv : nw.rv; const lines = side ? nw.n : nw.rows; const perLine = side ? 1 : nw.C;
    const span = side ? viewW() : viewH();
    let ay = side ? sx : sy;
    let fits = true;
    if (!top && hasAct) {
      fits = rowOf(act[act.length - 1]) - rowOf(act[0]) < vis && act.length <= vis * perLine;
      if (!fits && ptr) {
        // The active panes are locked to the edges: follow the pointer instead,
        // preferring an active pane if it is the one under the pointer.
        anchor = ptrAnchor; ay = side ? ptr.sx : ptr.sy; ptrPick = { sx: ptr.sx, sy: ptr.sy, i: ptrAnchor };
      }
    }
    const row = rowOf(anchor);
    let topRow = top ? 0 : row - Math.floor(vis * clamp(ay / span, 0, 0.999));
    if (!top && hasAct && fits) {
      const r0 = rowOf(act[0]); const r1 = rowOf(act[act.length - 1]);
      topRow = clamp(topRow, r1 - vis + 1, r0);
    } else if (!top && hasAct && !ptr) topRow = row - Math.floor((vis - 1) / 2);
    topRow = clamp(topRow, 0, Math.max(0, lines - vis));
    world.zoomBy = top ? 'reset' : hasAct && fits ? 'active' : ptr ? 'pointer' : hasAct ? 'active-middle' : 'centre';
    anim = null; Object.assign(cam, scrollCam(topRow * rowStride()));
    if (!motionOff()) { for (const f of from) { f.x += cam.x; f.y += cam.y; } world.tw = { from, t0: performance.now(), ms: 220 }; }
    schedule(); touched(); updateHud();
  };
  const FLAT_STEP = 0.18; const flatAcc = { v: 0, t: 0 };
  const stepFlat = (dir, sx, sy, act, ptr) => {
    const li = clamp(world.li + dir, 0, world.levels.length - 1); if (li === world.li) return;
    setFlatZoom(world.levels[world.d].shown / world.levels[li].shown, sx, sy, false, act, ptr);
  };
  // Zoom follows the active pane(s) — the focused thread, or every ⌘-selected
  // thread — not the pointer. Nothing active in the map: zoom about its centre.
  const activeIdx = () => {
    if (!world || !fr || !fr.map) return [];
    const ids = hasMulti() ? multiIds() : [state.selected];
    return ids.map((id) => indexOf(id)).filter((i) => i >= 0 && i < world.n).sort((a, b) => a - b);
  };
  // Where the pointer is over the map (keys use it too while it stays there).
  let lastPtr = null;
  const zoomFocus = (factor, ptrIn) => {
    const act = activeIdx(); const vw = viewW(); const vh = viewH();
    const ptr = ptrIn || lastPtr;
    if (!act.length) return ptr ? { sx: ptr.sx, sy: ptr.sy, act, ptr } : { sx: vw / 2, sy: vh / 2, act };
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const i of act) { const r = toScr(posAt(world, i)); x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    const onScreen = x1 > 0 && x0 < vw && y1 > 0 && y0 < vh;
    if (world.kind === 'flat') {
      const m = toScr(posAt(world, act[Math.floor((act.length - 1) / 2)]));
      return { sx: clamp(m.x + m.w / 2, 0, vw - 1), sy: onScreen ? clamp(m.y + m.h / 2, 0, vh - 1) : vh / 2, act, ptr };
    }
    // Nested map: zoom about the active panes until zooming in would push one
    // of them past the edge, then about the pointer.
    const growsOut = factor > 1 && ((x1 - x0) * factor > vw || (y1 - y0) * factor > vh);
    if (growsOut && ptr) return { sx: ptr.sx, sy: ptr.sy, act, ptr };
    return { sx: clamp((x0 + x1) / 2, 0, vw - 1), sy: clamp((y0 + y1) / 2, 0, vh - 1), act, ptr };
  };
  const zoomActive = (factor, ptr) => { const f = zoomFocus(factor, ptr); zoomAt(f.sx, f.sy, factor, f.act, f.ptr); };
  const zoomAt = (sx, sy, factor, act, ptr) => {
    // One level at a time: a mouse wheel notch is one step, and a trackpad
    // pinch adds up its small moves until they make one, so it never skips.
    if (world && world.kind === 'flat') {
      const now = performance.now(); if (now - flatAcc.t > 400) flatAcc.v = 0; flatAcc.t = now;
      flatAcc.v += Math.log(factor);
      if (Math.abs(flatAcc.v) >= FLAT_STEP) { const dir = flatAcc.v > 0 ? 1 : -1; flatAcc.v = 0; stepFlat(dir, sx, sy, act, ptr); }
      return;
    }
    const z1 = clamp(cam.z * factor, zMin(), Z_MAX); const wx = cam.x + sx / cam.z; const wy = cam.y + sy / cam.z;
    setCam({ z: z1, x: wx - sx / z1, y: wy - sy / z1 });
  };
  // own: only move along the axis asked for (edge panning while dragging).
  const panBy = (dx, dy, own) => {
    if (world && world.kind === 'flat') {
      // Vertical bands: an ordinary up/down scroll moves sideways too.
      if (sideways()) { setCam({ z: 1, x: cam.x + (own || Math.abs(dx) >= Math.abs(dy) ? dx : dy), y: 0 }); return; }
      setCam({ z: 1, x: 0, y: cam.y + dy }); return;
    }
    setCam({ z: cam.z, x: cam.x + dx / cam.z, y: cam.y + dy / cam.z });
  };
  // Back goes to where you were before each zoom, Fit, Reset or jump.
  const pushHist = () => {
    if (!fr || !fr.map) return;
    const k = camKey(); const last = state.hist.at(-1);
    if (last && last.k === k && Math.abs(Math.log(last.z / cam.z)) < 0.01 && Math.hypot(last.x - cam.x, last.y - cam.y) * cam.z < 3) return;
    state.hist.push({ k, z: cam.z, x: cam.x, y: cam.y }); if (state.hist.length > 60) state.hist.shift();
    updateHud();
  };
  const backTarget = () => { const k = camKey(); for (let i = state.hist.length - 1; i >= 0; i--) if (state.hist[i].k === k) return state.hist[i]; return null; };
  const back = () => {
    const k = camKey();
    while (state.hist.length) { const h = state.hist.pop(); if (h.k === k) { animateTo(h, true); return; } }
    updateHud(); toast('No earlier zoom to go back to');
  };
  // Glide the camera. Zoom changes keep one point fixed on screen, so it reads
  // as zooming toward a place rather than sliding and scaling separately.
  const animateTo = (target, noPush) => {
    if (!fr || !fr.map) return;
    if (!noPush) pushHist();
    const b = clampCam({ z: target.z, x: target.x, y: target.y });
    if (motionOff()) { Object.assign(cam, b); schedule(); touched(); updateHud(); return; }
    const a = { ...cam }; const steps = Math.abs(Math.log2(b.z / a.z));
    anim = { a, b, t0: performance.now(), ms: Math.min(900, 300 + 55 * steps) };
    const run = anim;
    const step = (now) => {
      if (anim !== run) return;
      const u = Math.min(1, (now - run.t0) / run.ms); const e = 1 - Math.pow(1 - u, 3);
      const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * e);
      if (Math.abs(b.z - a.z) > 1e-9 * Math.max(a.z, b.z)) {
        const Px = (b.x * b.z - a.x * a.z) / (b.z - a.z); const Py = (b.y * b.z - a.y * a.z) / (b.z - a.z);
        const sx = (Px - a.x) * a.z; const sy = (Py - a.y) * a.z;
        cam.x = Px - sx / z; cam.y = Py - sy / z;
      } else { cam.x = a.x + (b.x - a.x) * e; cam.y = a.y + (b.y - a.y) * e; }
      cam.z = z;
      if (u >= 1) { Object.assign(cam, b); anim = null; }
      paint(null); touched();
      if (u < 1) requestAnimationFrame(step); else updateHud();
    };
    requestAnimationFrame(step);
  };
  const resetCam = () => {
    if (world && world.kind === 'flat') { setFlatZoom(1, 0, 0, true); Object.assign(cam, scrollCam(0)); return; }
    animateTo({ z: 1, x: 0, y: 0 });
  };
  const fitCam = () => {
    if (world && world.kind === 'flat') { if (world.n) setFlatZoom(world.levels[world.d].shown / world.levels[0].shown, 0, 0, true); return; }
    animateTo({ z: Math.min(1, fitZ()), x: 0, y: 0 });
  };
  const zoomBy = (f) => {
    const af = zoomFocus(f);
    if (world && world.kind === 'flat') { if (world.n) stepFlat(f > 1 ? 1 : -1, af.sx, af.sy, af.act, af.ptr); return; }
    const z1 = clamp(cam.z * f, zMin(), Z_MAX); const wx = cam.x + af.sx / cam.z; const wy = cam.y + af.sy / cam.z; animateTo({ z: z1, x: wx - af.sx / z1, y: wy - af.sy / z1 });
  };
  // Show a pane at a readable size: zoom to 100% (or what fits), centered on it.
  const zoomToRect = (r, leaf) => {
    const vw = viewW(); const vh = viewH();
    let z = leaf ? Math.min(1, vw / r.w, vh / r.h) : Math.min((vw - 24) / r.w, (vh - 24) / r.h);
    if (leaf) z = Math.max(z, Math.min(Z_MAX, Math.max(LIVE_W / r.w, LIVE_H / r.h)));
    animateTo({ z, x: r.x + r.w / 2 - vw / 2 / z, y: r.y + r.h / 2 - vh / 2 / z });
  };
  // Bring a thread's pane into view without changing anything else.
  const reveal = (id) => {
    if (!fr) return;
    if (state.full === id || fr.mainId === id) { const p = panes.get(id); if (p) flash(p); return; }
    if (!fr.map) return;
    const i = indexOf(id); if (i < 0) return;
    const r = posAt(world, i); const s = toScr(r);
    const inView = s.x >= -1 && s.y >= -1 && s.x + s.w <= viewW() + 1 && s.y + s.h <= viewH() + 1;
    if (inView && s.w >= LIVE_W && s.h >= LIVE_H) { const p = panes.get(id); if (p) flash(p); return; }
    let z = cam.z;
    if (r.w * z < LIVE_W || r.h * z < LIVE_H) z = Math.max(Math.min(1, viewW() / r.w, viewH() / r.h), LIVE_W / r.w, LIVE_H / r.h);
    const vw = viewW() / z; const vh = viewH() / z; let x = cam.x; let y = cam.y;
    if (z !== cam.z) { x = r.x + r.w / 2 - vw / 2; y = r.y + r.h / 2 - vh / 2; }
    else { if (r.x < x) x = r.x; else if (r.x + r.w > x + vw) x = r.x + r.w - vw; if (r.y < y) y = r.y; else if (r.y + r.h > y + vh) y = r.y + r.h - vh; }
    animateTo({ z, x, y });
    setTimeout(() => { const p = panes.get(id); if (p && p.isConnected) flash(p); }, motionOff() ? 0 : 480);
  };

  // ---------- drawing the map ----------
  const livePanes = new Map(); const leaving = new Map();
  let hover = null; let lastStats = null;
  let hatchPat = null;
  const hatch = (ctx) => {
    if (hatchPat) return hatchPat;
    const c = document.createElement('canvas'); c.width = c.height = 8; const g = c.getContext('2d');
    g.strokeStyle = theme().muted; g.globalAlpha = 0.3; g.lineWidth = 1;
    g.beginPath(); g.moveTo(-1, 9); g.lineTo(9, -1); g.moveTo(-1, 1); g.lineTo(1, -1); g.moveTo(7, 9); g.lineTo(9, 7); g.stroke();
    hatchPat = ctx.createPattern(c, 'repeat'); return hatchPat;
  };
  const leadOf = (t) => { const m = members(t)[0]; const b = m && botFor(m); return b ? { color: b.color, seed: b.seed } : { color: '#8b8b8b', seed: '' }; };
  const leafInfo = (i) => {
    if (i < world.nReal) {
      const id = world.ids[i]; const t = T(id); const msgs = allMessages(t); const lead = leadOf(t); const last = msgs.at(-1);
      const isMulti = hasMulti() && state.multiSelected.has(id);
      return { id, title: t.title, color: lead.color, seed: lead.seed, syn: false, sel: id === state.selected, multi: isMulti, last: last ? `${last.speaker}: ${last.text.replace(/[*`#>]/g, '').replace(/\s+/g, ' ').slice(0, 180)}` : (members(t).length ? 'No messages yet' : 'No agents yet') };
    }
    const s = synAt(i - world.nReal); const [a] = synLead(s);
    const synId = SYN + s;
    return { id: synId, title: `Synthetic thread ${fmt(s + 1)}`, color: a.color, seed: a.seed, syn: true, sel: state.selected === synId, multi: false, last: `${a.name}: Synthetic reply, made up for the scale test.` };
  };
  const wrapLines = (ctx, text, w, max) => {
    const out = []; let line = '';
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= w) { line = next; continue; }
      if (line) out.push(line); line = word;
      if (out.length >= max) break;
    }
    if (out.length < max && line) out.push(line);
    if (out.length === max && ctx.measureText(out[max - 1]).width > w - 8) out[max - 1] = out[max - 1].slice(0, -2) + '…';
    return out.slice(0, max);
  };
  // A pane too small to be live, drawn like one. Detail comes in the order it
  // is useful: the name first, then the last words, then a title bar and more lines.
  const drawCard = (ctx, r, it, hot) => {
    const t = theme(); const rad = Math.min(6, r.w * 0.05, r.h * 0.1);
    ctx.fillStyle = t.bg; ctx.beginPath(); ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, rad); ctx.fill();
    if (it.syn) { ctx.save(); ctx.clip(); ctx.fillStyle = hatch(ctx); ctx.fillRect(r.x, r.y, r.w, r.h); ctx.restore(); }
    // Multi-selected outline must be visible even when drawn as a picture (smallest zoom step)
    const isMulti = !!it.multi;
    if (isMulti) {
      ctx.save();
      ctx.strokeStyle = t.accent; ctx.lineWidth = 2.5;
      ctx.shadowColor = t.accent; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, rad); ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = isMulti ? t.accent : it.sel ? t.accent : hot ? t.text : t.line; ctx.lineWidth = (isMulti || it.sel || hot) ? 1.5 : 1; ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(r.x + 1, r.y + 1, r.w - 4, r.h - 2); ctx.clip();
    const compact = r.h < 58;
    const bar = compact ? r.h : clamp(r.h * 0.18, 16, 28);
    const fs = compact ? Math.min(12, r.h * 0.3, r.w / 7) : Math.min(12, bar * 0.48);
    const dot = Math.max(1.5, Math.min(3.5, fs * 0.28)); const dx = r.x + Math.max(5, Math.min(9, r.w * 0.06));
    const ty = compact ? r.y + Math.min(r.h / 2, fs + 3) : r.y + bar / 2;
    ctx.fillStyle = it.color; ctx.beginPath(); ctx.arc(dx, ty, dot, 0, 7); ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if (fs >= 6.5 && r.w > 40) { ctx.fillStyle = t.text; ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`; ctx.fillText(it.title, dx + dot + 4, ty); }
    else if (r.w > 14) { const ga = ctx.globalAlpha; ctx.fillStyle = t.muted; ctx.globalAlpha = ga * 0.5; ctx.fillRect(dx + dot + 3, ty - 0.5, Math.max(2, r.w * 0.5), 1); ctx.globalAlpha = ga; }
    if (compact) {
      const bfs = Math.min(11, fs * 0.9);
      if (bfs >= 6.5 && r.h >= fs * 2 + bfs * 1.4 + 2) { ctx.font = `${bfs}px system-ui, -apple-system, sans-serif`; ctx.fillStyle = t.muted; ctx.fillText(wrapLines(ctx, it.last, r.w - 14, 1)[0] || '', r.x + 7, ty + fs * 0.62 + bfs * 1.05); }
      ctx.restore(); return;
    }
    ctx.strokeStyle = t.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(r.x + 1, r.y + bar); ctx.lineTo(r.x + r.w - 1, r.y + bar); ctx.stroke();
    const body = r.h - bar; const pad = Math.max(4, Math.min(10, r.w * 0.05));
    const bfs = Math.min(12, Math.max(r.w / 18, body / 7));
    if (bfs >= 7.5 && body > bfs * 2) {
      ctx.font = `${bfs}px system-ui, -apple-system, sans-serif`; ctx.textBaseline = 'top'; ctx.fillStyle = t.muted;
      const lines = wrapLines(ctx, it.last, r.w - pad * 2, Math.max(1, Math.floor((body - pad) / (bfs * 1.35))));
      lines.forEach((l, n) => ctx.fillText(l, r.x + pad, r.y + bar + pad * 0.8 + n * bfs * 1.35));
    } else if (body > 6) {
      const face = Math.min(22, body * 0.32, r.w * 0.16);
      if (face >= 4) ctx.drawImage(sprite(it.seed, it.color, spritePx(face * 2)), r.x + pad, r.y + bar + pad, face, face);
      const ga = ctx.globalAlpha; ctx.fillStyle = t.muted; ctx.globalAlpha = ga * 0.35; const lh = Math.max(1, face * 0.26);
      for (let l = 0; l < 3; l++) { const ly = r.y + bar + pad * 1.6 + face + l * lh * 2.4; if (ly + lh > r.y + r.h - pad * 0.6) break; ctx.fillRect(r.x + pad, ly, (r.w - 2 * pad) * (0.5 + 0.4 * ((hash(l + it.title.length) % 100) / 100)), lh); }
      ctx.globalAlpha = ga;
    }
    ctx.restore();
  };
  const drawLeaf = (ctx, i, s, a, stats) => {
    if (a < 0.02) return;
    const it = leafInfo(i); const hot = hover && hover.kind === 'leaf' && hover.i === i;
    ctx.globalAlpha = a;
    if (s.w >= 34 && s.h >= 20) { drawCard(ctx, s, it, hot); stats.cards++; }
    else {
      const t = theme();
      const isMulti = !!it.multi;
      ctx.fillStyle = isMulti ? t.accent : it.sel ? t.accent : hot ? t.text : it.color;
      ctx.globalAlpha = a * (isMulti || it.sel || hot ? 1 : it.syn ? 0.42 : 0.8);
      const r = Math.min(3, s.w * 0.2);
      if (s.w >= 4) { ctx.beginPath(); ctx.roundRect(s.x, s.y, s.w, s.h, r); ctx.fill(); } else ctx.fillRect(s.x, s.y, Math.max(1.5, s.w), Math.max(1.5, s.h));
      // tiny dot multi outline: draw thicker stroke around it
      if (isMulti) {
        const c = theme();
        ctx.save();
        ctx.globalAlpha = a;
        ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.roundRect(s.x - 1, s.y - 1, s.w + 2, s.h + 2, r + 1); ctx.stroke();
        ctx.restore();
      }
      stats.chips++;
    }
    ctx.globalAlpha = 1;
  };
  const fitText = (ctx, text, w, size, weight) => {
    let fs = size; ctx.font = `${weight} ${fs}px system-ui, -apple-system, sans-serif`;
    const tw = ctx.measureText(text).width; if (tw > w) { fs = Math.floor(fs * w / tw); ctx.font = `${weight} ${fs}px system-ui, -apple-system, sans-serif`; }
    return fs;
  };
  // A block whose contents are too small to draw one by one.
  const drawBlock = (ctx, s, first, count, a, stats) => {
    if (a < 0.02) return; stats.blocks++;
    const t = theme(); const sw = Math.max(1, s.w); const sh = Math.max(1, s.h); const yours = first < world.nReal;
    const hot = hover && hover.kind === 'group' && hover.first === first && hover.count === count;
    if (sw < 4) { ctx.globalAlpha = a * 0.55; ctx.fillStyle = yours ? t.accent : t.muted; ctx.fillRect(s.x, s.y, sw, sh); ctx.globalAlpha = 1; return; }
    ctx.globalAlpha = a; const rad = Math.min(10, sw * 0.08);
    ctx.fillStyle = sw < 24 ? t.line : t.panel; ctx.beginPath(); ctx.roundRect(s.x + 0.5, s.y + 0.5, sw - 1, sh - 1, rad); ctx.fill();
    ctx.save(); ctx.clip(); if (sw >= 24) { ctx.fillStyle = hatch(ctx); ctx.fillRect(s.x, s.y, sw, sh); }
    // A faint 10 × 10 grid: there are a hundred things in here.
    if (sw >= 60) { ctx.strokeStyle = t.line; ctx.lineWidth = 1; ctx.beginPath(); for (let g = 1; g < B; g++) { const gx = Math.round(s.x + sw * g / B) + 0.5; const gy = Math.round(s.y + sh * g / B) + 0.5; ctx.moveTo(gx, s.y); ctx.lineTo(gx, s.y + sh); ctx.moveTo(s.x, gy); ctx.lineTo(s.x + sw, gy); } ctx.stroke(); }
    ctx.restore();
    ctx.beginPath(); ctx.roundRect(s.x + 0.5, s.y + 0.5, sw - 1, sh - 1, rad);
    ctx.strokeStyle = hot ? t.text : yours ? t.accent : t.line; ctx.lineWidth = hot || yours ? 1.5 : 1; ctx.stroke();
    if (sw >= 72 && sh >= 40) {
      const cx = s.x + sw / 2; const cy = s.y + sh / 2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const big = `${fmt(count)} threads`; const fs = fitText(ctx, big, sw - 14, clamp(Math.min(sw / 9, sh / 3.4), 10, 17), 600);
      if (fs >= 8) {
        const lines = yours ? 3 : 2; const y0 = cy - (lines - 1) * fs * 0.62;
        ctx.fillStyle = t.text; ctx.fillText(big, cx, y0);
        ctx.fillStyle = t.muted; ctx.font = `${Math.max(8, fs * 0.8)}px system-ui, -apple-system, sans-serif`;
        ctx.fillText(`${fmt(first + 1)}–${fmt(first + count)}`, cx, y0 + fs * 1.25);
        if (yours) { ctx.fillStyle = t.accent; ctx.fillText(`${Math.min(count, world.nReal - first)} yours · rest synthetic`, cx, y0 + fs * 2.4); }
      }
    }
    ctx.globalAlpha = 1;
  };
  // A block whose contents are drawn: an outline and its label.
  const drawFrame = (ctx, k, s, first, count, a) => {
    if (a < 0.02 || s.w < 24) return;
    const t = theme(); const L = world.L[k]; const z = cam.z;
    const hot = hover && hover.kind === 'group' && hover.first === first && hover.count === count;
    ctx.globalAlpha = a; ctx.strokeStyle = hot ? t.text : first < world.nReal ? t.accent : t.line; ctx.lineWidth = hot ? 1.5 : 1;
    ctx.beginPath(); ctx.roundRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1, Math.min(14, 4 + s.w * 0.01)); ctx.stroke();
    const head = L.padTop * z;
    if (head >= 15 && s.w >= 120) {
      const fs = clamp(head * 0.36, 11, 15); const x0 = s.x + L.padX * z; const y0 = s.y + head * 0.55;
      ctx.save(); ctx.beginPath(); ctx.rect(s.x, s.y, s.w, head); ctx.clip();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const label = `Threads ${fmt(first + 1)}–${fmt(first + count)}`;
      ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`; ctx.fillStyle = t.text; ctx.fillText(label, x0, y0);
      const w1 = ctx.measureText(label).width; const yours = first < world.nReal ? Math.min(count, world.nReal - first) : 0;
      ctx.font = `${fs - 1}px system-ui, -apple-system, sans-serif`; ctx.fillStyle = yours ? t.accent : t.muted;
      ctx.fillText(yours ? `· ${yours} yours, ${fmt(count - yours)} synthetic` : '· synthetic', x0 + w1 + 8, y0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  };

  // When a block's header strip is too thin for its label, float a small one
  // over its top-left corner, drawn after its contents like a label on a map.
  const drawFrameLabel = (ctx, k, s, first, count, a) => {
    const t = theme(); const L = world.L[k];
    if (a < 0.05 || L.padTop * cam.z >= 15 || s.w < 60 || s.h < 34) return;
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    let label = `${fmt(first + 1)}–${fmt(first + count)}`;
    if (ctx.measureText(label).width + 12 > s.w - 8) label = `${compact(first + 1)}–${compact(first + count)}`;
    const lw = Math.min(s.w - 8, ctx.measureText(label).width + 12); const lx = Math.max(s.x + 4, Math.min(4, s.x + s.w - lw - 4)); const ly = Math.max(s.y + 4, Math.min(4, s.y + s.h - 22));
    ctx.globalAlpha = a * 0.95; ctx.fillStyle = t.bg; ctx.beginPath(); ctx.roundRect(lx, ly, lw, 18, 5); ctx.fill();
    ctx.strokeStyle = first < world.nReal ? t.accent : t.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(lx, ly, lw, 18); ctx.clip();
    ctx.globalAlpha = a; ctx.fillStyle = t.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, lx + 6, ly + 9.5); ctx.restore();
    ctx.globalAlpha = 1;
  };

  const AX_MAX = 60; const axSeen = [];
  const axLabel = (h) => {
    if (h.kind === 'leaf') { const it = leafInfo(h.i); return `Zoom to ${it.title}${it.syn ? ' (synthetic)' : ''}`; }
    return `Zoom to threads ${fmt(h.first + 1)} to ${fmt(h.first + h.count)} (${fmt(h.count)} threads)`;
  };
  // Each button sits invisibly over its card (pointer events pass through to
  // the map), so assistive tech and automation can find and press it in place.
  const placeAx = () => { for (const b of axList.children) { const s = toScr(b._h.r); const x = clamp(s.x, 0, viewW()); const y = clamp(s.y, 0, viewH()); b.style.left = `${x}px`; b.style.top = `${y}px`; b.style.width = `${Math.max(1, Math.min(s.x + s.w, viewW()) - x)}px`; b.style.height = `${Math.max(1, Math.min(s.y + s.h, viewH()) - y)}px`; } };
  const syncAx = () => {
    const items = fr && fr.map && !state.full ? axSeen.slice() : [];
    const key = items.map((h) => (h.kind === 'leaf' ? `l${h.i}` : `g${h.first}:${h.count}`)).join(',');
    if (axList._key === key) { placeAx(); return; } axList._key = key;
    axList.replaceChildren(...items.map((h) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mk-ax-btn'; b.setAttribute('role', 'listitem'); b.textContent = axLabel(h); b._h = h;
      const center = () => { const s = toScr(h.r); return [clamp(s.x + Math.min(s.w, viewW()) / 2, 0, viewW()), clamp(s.y + Math.min(s.h, viewH()) / 2, 0, viewH())]; };
      b.addEventListener('focus', () => { const [x, y] = center(); setHover({ ...h }, x, y); });
      b.addEventListener('blur', () => setHover(null));
      b.addEventListener('click', () => { anim = null; setHover(null); if (h.kind === 'leaf') zoomToRect(h.r, true); else zoomToRect(h.r, false); mapEl.focus({ preventScroll: true }); });
      return b;
    }));
    placeAx();
  };

  // Real panes on screen: mount, size, keep the reading place; retire the rest.
  const setRect = (p, s) => {
    const x = Math.round(s.x); const y = Math.round(s.y); const w = Math.round(s.w); const h = Math.round(s.h);
    if (p._x !== x) { p.style.left = `${x}px`; p._x = x; }
    if (p._y !== y) { p.style.top = `${y}px`; p._y = y; }
    if (p._w === w && p._h === h) return false;
    p.style.width = `${w}px`; p.style.height = `${h}px`; p._w = w; p._h = h; return true;
  };
  const unleave = (id, p) => { if (p._leaving) { clearTimeout(p._leaving); p._leaving = 0; } p.classList.remove('mk-leaving'); leaving.delete(id); };
  const retire = (id, p) => {
    saveScroll(id, p);
    if (motionOff() || !p.isConnected || p.parentElement !== liveLayer) { if (p.parentElement === liveLayer) p.remove(); return; }
    p.classList.add('mk-leaving'); leaving.set(id, p);
    p._leaving = setTimeout(() => { p._leaving = 0; leaving.delete(id); p.classList.remove('mk-leaving'); if (p.parentElement === liveLayer && !livePanes.has(id)) p.remove(); }, 150);
  };
  const syncLive = (want, except) => {
    for (const [id, p] of livePanes) if (!want.has(id) && p !== except) { livePanes.delete(id); retire(id, p); }
    const jobs = [];
    for (const [id, s] of want) {
      const p = paneOf(id); if (p === except) continue;
      if (livePanes.get(id) === p && p.parentElement === liveLayer) {
        const resized = Math.round(s.w) !== p._w || Math.round(s.h) !== p._h;
        jobs.push({ id, p, s, a: resized ? anchorOf(p) : null, fresh: false });
      } else jobs.push({ id, p, s, a: p.isConnected ? anchorOf(p) || state.scrolls.get(id) : state.scrolls.get(id), fresh: true });
    }
    for (const j of jobs) {
      if (j.fresh) { unleave(j.id, j.p); if (j.p.parentElement !== liveLayer) liveLayer.append(j.p); livePanes.set(j.id, j.p); j.p._fitW = 0; }
      j.resized = setRect(j.p, j.s);
    }
    for (const j of jobs) {
      if (j.fresh) applyAnchor(j.p, j.a || { pinned: true });
      else if (j.resized && j.a) applyAnchor(j.p, j.a);
      if (j.fresh || j.resized) fitPane(j.p, !!moving && !j.fresh);
    }
    // Preserve multi-select outline across zoom/pan remounts
    if (hasMulti()) {
      for (const j of jobs) if (state.multiSelected.has(j.id)) j.p.classList.add('mk-multi-selected');
    }
    evictSyn();
  };
  const evictSyn = () => {
    if (panes.size <= 90) return;
    for (const [id, p] of panes) {
      if (panes.size <= 60) break;
      if (!isSyn(id) || livePanes.has(id) || leaving.has(id) || id === state.selected || id === state.full || (drag && drag.id === id)) continue;
      saveScroll(id, p); p.remove(); panes.delete(id);
    }
  };
  const mountMain = (except) => {
    for (const p of $$(':scope > .pane', mainRegion)) if ((!fr.mainId || p.dataset.id !== fr.mainId) && p !== except) { saveScroll(p.dataset.id, p); p.remove(); }
    if (!fr.mainId) return;
    const p = paneOf(fr.mainId); if (p === except) return;
    const r = { x: 0, y: 0, w: fr.main.w, h: fr.main.h };
    if (p.parentElement !== mainRegion) {
      const a = p.isConnected ? anchorOf(p) || state.scrolls.get(fr.mainId) : state.scrolls.get(fr.mainId);
      if (livePanes.get(fr.mainId) === p) livePanes.delete(fr.mainId);
      unleave(fr.mainId, p);
      mainRegion.append(p); setRect(p, r); applyAnchor(p, a || { pinned: true }); fitPane(p, false);
    } else {
      const resized = Math.round(r.w) !== p._w || Math.round(r.h) !== p._h; const a = resized ? anchorOf(p) : null;
      setRect(p, r); if (resized) { if (a) applyAnchor(p, a); fitPane(p, !!moving); }
    }
    if (hasMulti() && state.multiSelected.has(fr.mainId)) p.classList.add('mk-multi-selected');
  };
  const box = (el, r) => { el.style.left = `${r.x}px`; el.style.top = `${r.y}px`; el.style.width = `${r.w}px`; el.style.height = `${r.h}px`; };
  let colBars = [];
  const place = (except) => {
    const ids = openIds();
    fr = frameFor(ids);
    world = makeWorld(fr.map || { w: 1, h: 1 }, fr.mapIds);
    if (fr.map) { loadCam(); if (world.kind === 'flat' && world.n && !moving && !anim) Object.assign(cam, scrollCam(snappedY())); }
    ui.grid.classList.toggle('mk-has-full', !!state.full);
    ui.grid.classList.toggle('mk-multi', !state.full && ids.length + synCount() > 1);
    mainRegion.hidden = !fr.main; if (fr.main) box(mainRegion, fr.main);
    mapEl.hidden = !fr.map; if (fr.map) box(mapEl, fr.map);
    const narrow = !!fr.map && fr.map.w < 340; mapEl.toggleAttribute('data-narrow', narrow);
    split.hidden = fr.split == null;
    if (fr.split != null) { split.style.left = `${fr.split}px`; split.setAttribute('aria-label', `Resize the focus pane, now ${Math.round(fr.main.w)} px wide`); }
    mountMain(except);
    paint(except);
  };
  const paint = (except) => {
    if (!fr) return;
    if (!fr.map) { syncLive(new Map(), except); for (const [id, p] of leaving) { unleave(id, p); if (p.parentElement === liveLayer) p.remove(); } hideTip(); placeBars(); updateHud(); return; }
    const vw = fr.map.w; const vh = fr.map.h; const z = cam.z;
    const dpr = Math.min(2, devicePixelRatio || 1); const W = Math.round(vw * dpr); const H = Math.round(vh * dpr);
    if (mapCv.width !== W || mapCv.height !== H) { mapCv.width = W; mapCv.height = H; mapCv.style.width = `${vw}px`; mapCv.style.height = `${vh}px`; }
    const ctx = mapCv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, vw, vh);
    const m = 2 / z; const v = { x0: cam.x - m, y0: cam.y - m, x1: cam.x + vw / z + m, y1: cam.y + vh / z + m };
    const want = new Map(); const near = new Map(); axSeen.length = 0;
    const stats = { live: 0, cards: 0, chips: 0, blocks: 0, budget: 30000 };
    walk(world, z, v, stats, {
      leaf: (i, r, a) => {
        const s = toScr(r);
        if (s.w >= LIVE_W * 0.5 && (leaving.size || s.w >= LIVE_W)) {
          const id = idAt(i);
          if (s.w >= LIVE_W && s.h >= LIVE_H && want.size < LIVE_CAP) { want.set(id, s); stats.live++; }
          if (leaving.has(id)) near.set(id, s);
        }
        drawLeaf(ctx, i, s, a, stats); // under a live pane it only shows while the pane fades in
        if (s.w < LIVE_W && s.w >= 34 && s.h >= 20 && a > 0.5 && axSeen.length < AX_MAX && s.x + s.w > 0 && s.y + s.h > 0 && s.x < vw && s.y < vh) axSeen.push({ kind: 'leaf', i, r });
      },
      block: (k, r, first, count, a) => { const sr = toScr(r); drawBlock(ctx, sr, first, count, a, stats); if (a > 0.5 && sr.w >= 40 && axSeen.length < AX_MAX && sr.x + sr.w > 0 && sr.y + sr.h > 0 && sr.x < vw && sr.y < vh) axSeen.push({ kind: 'group', k, first, count, r }); },
      frame: (k, r, first, count, a) => drawFrame(ctx, k, toScr(r), first, count, a),
      label: (k, r, first, count, a) => drawFrameLabel(ctx, k, toScr(r), first, count, a)
    });
    syncLive(want, except);
    for (const [id, p] of leaving) { const s = near.get(id); if (s) setRect(p, s); else { unleave(id, p); if (!livePanes.has(id) && p.parentElement === liveLayer) p.remove(); } }
    lastStats = stats;
    if (world.kind === 'flat' && world.tw) schedule(); // keep gliding
    placeBars(); updateHud(); drawMini();
  };
  // Move panes with a short glide from where they were (FLIP, translate only).
  const glide = (mutate, skip) => {
    const before = new Map();
    if (!reduced) for (const p of panes.values()) if (p.isConnected && p !== skip) before.set(p, p.getBoundingClientRect());
    mutate();
    for (const [p, b] of before) {
      if (!p.isConnected) continue;
      p.getAnimations().forEach((a) => { if (a.id === 'mk-glide') a.cancel(); });
      const a = p.getBoundingClientRect(); const dx = b.left - a.left; const dy = b.top - a.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const an = p.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' }); an.id = 'mk-glide';
    }
  };
  const render = (animate) => {
    if (state.full && !(isSyn(state.full) ? T(state.full) : openIds().includes(state.full))) state.full = null;
    if (animate) glide(() => place()); else place();
    for (const [id, p] of panes) {
      p.classList.toggle('focused', id === state.selected);
      p.classList.toggle('mk-full', id === state.full);
      p.classList.toggle('mk-multi-selected', hasMulti() && state.multiSelected.has(id));
      const max = $('.pane-head > button.icon.small', p);
      const full = id === state.full;
      max.textContent = full ? '▣' : '□';
      max.setAttribute('aria-label', full ? 'Restore layout' : 'Maximize pane');
      max.title = full ? 'Restore layout' : 'Maximize';
    }
    renderSidebar();
    renderComposer();
    renderDetails();
    requestAnimationFrame(fitAll);
  };

  // ---------- map HUD: where you are, zoom, Fit, Back, and a small map ----------
  const hud = document.createElement('div'); hud.className = 'mk-hud mk-mapbar'; hud.setAttribute('role', 'toolbar'); hud.setAttribute('aria-label', 'Thread map');
  const hb = (act, label, title, text) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.act = act; b.setAttribute('aria-label', label); b.title = title; b.textContent = text; return b; };
  const hNew = document.createElement('span'); hNew.className = 'mk-new'; hNew.textContent = 'new';
  const hWhere = hb('where', 'Where you are. Show or hide the small map', 'Where you are · click to show or hide the small map', '');
  hWhere.classList.add('mk-hud-where');
  const sep = () => { const s = document.createElement('span'); s.className = 'mk-hud-sep'; s.setAttribute('aria-hidden', 'true'); return s; };
  const hOut = hb('out', 'Zoom out', 'Zoom out (−)', '−');
  const hPct = hb('reset', 'Reset to 100%', 'Reset to 100% (0)', '100%'); hPct.classList.add('mk-hud-pct');
  const hIn = hb('in', 'Zoom in', 'Zoom in (+)', '+');
  const hFit = hb('fit', 'Fit open threads', 'Fit open threads (⇧1)', 'Fit');
  const hBack = hb('back', 'Back to the previous zoom', 'Back (⌫)', '');
  const hBackIcon = document.createElement('span'); hBackIcon.setAttribute('aria-hidden', 'true'); hBackIcon.textContent = '←';
  const hBackText = document.createElement('span'); hBackText.className = 'mk-hud-lbl'; hBackText.textContent = ' Back';
  hBack.append(hBackIcon, hBackText);
  const hSay = document.createElement('span'); hSay.className = 'mk-sr'; hSay.setAttribute('role', 'status');
  const hGrow = document.createElement('span'); hGrow.className = 'mk-hud-grow';
  hud.append(hNew, hWhere, hGrow, hOut, hPct, hIn, sep(), hFit, hBack, hSay);
  const mini = document.createElement('div'); mini.className = 'mk-mini'; mini.hidden = true;
  const crumbs = document.createElement('div'); crumbs.className = 'mk-mini-crumbs';
  const miniCv = document.createElement('canvas'); miniCv.setAttribute('role', 'img'); miniCv.setAttribute('aria-label', 'Small map of every thread here. Click or drag to move there.');
  const miniStat = document.createElement('div'); miniStat.className = 'mk-mini-stat';
  mini.append(crumbs, miniCv, miniStat);
  ui.grid.append(hud); mapEl.append(mini);
  hud.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    anim = null;
    ({ where: () => { state.mini = !miniShown(); drawMini(); }, out: () => zoomBy(0.5), in: () => zoomBy(2), reset: resetCam, fit: fitCam, back })[b.dataset.act]();
  });
  const pctText = (z) => { const p = z * 100; return p >= 10 ? `${Math.round(p)}%` : p >= 0.1 ? `${p.toFixed(1)}%` : `${Number(p.toPrecision(2))}%`; };
  const whereNow = () => {
    if (!fr || !fr.map) return { short: '', long: '', chain: [] };
    if (!world.n) return { short: 'No threads here', long: 'No other threads', chain: [] };
    const vw = viewW() / cam.z; const vh = viewH() / cam.z;
    if (world.kind === 'flat') {
      let a = -1; let b = -1;
      for (let i = 0; i < world.n; i++) { const r = posAt(world, i); const cx = r.x + r.w / 2; const cy = r.y + r.h / 2; if (cx >= cam.x && cx <= cam.x + vw && cy >= cam.y && cy <= cam.y + vh) { if (a < 0) a = i; b = i; } }
      if (a < 0) { a = b = clamp(sideways() ? Math.floor((cam.x + vw / 2) / rowStride()) : Math.floor((cam.y + vh / 2) / rowStride()) * world.C, 0, world.n - 1); }
      const all = a === 0 && b === world.n - 1;
      const range = all ? `All ${fmt(world.n)}` : a === b ? `${fmt(a + 1)} of ${fmt(world.n)}` : `${fmt(a + 1)}–${fmt(b + 1)} of ${fmt(world.n)}`;
      return { short: range, long: all ? `All ${fmt(world.n)} threads` : `Threads ${range}`, chain: [] };
    }
    const chain = groupChain(cam.x + vw / 2, cam.y + vh / 2).filter((c) => Math.max(c.r.w / vw, c.r.h / vh) >= 0.98);
    const deep = chain.at(-1) || null;
    const short = deep ? `${fmt(deep.first + 1)}–${fmt(deep.first + deep.count)} of ${fmt(world.n)}` : `All ${fmt(world.n)}`;
    return { short, long: deep ? `Threads ${short}` : `All ${fmt(world.n)} threads`, chain };
  };
  let saidKey = '';
  const updateHud = (final) => {
    hud.hidden = true; mini.hidden = true;
    if (!(fr && fr.map) || state.full) return;
    const on = !!(fr && fr.map) && !state.full;
    if (!on) { mini.hidden = true; return; }
    const w = whereNow(); hWhere.textContent = hud.hasAttribute('data-narrow') ? w.short : w.long;
    hWhere.title = `${w.long} · click to show or hide the small map`;
    const p = pctText(cam.z); hPct.textContent = p; hPct.setAttribute('aria-label', `Zoom ${p}. Reset to 100%`);
    hIn.disabled = cam.z >= Z_MAX - 1e-6; hOut.disabled = cam.z <= zMin() + 1e-9;
    const bt = backTarget(); hBack.disabled = !bt; hBack.title = bt ? `Back to ${pctText(bt.z)} (⌫)` : 'Back (nothing to go back to yet)';
    hBack.setAttribute('aria-label', bt ? `Back to ${pctText(bt.z)}` : 'Back');
    if (final) { const say = `Zoom ${p}. ${w.long}.`; if (say !== saidKey) { saidKey = say; hSay.textContent = say; } }
  };
  // The small map shows when you are zoomed out (or in a nested map) and part
  // of the map is off screen; the "where" button turns it on or off by hand.
  const offScreen = () => world.W * cam.z > viewW() + 1 || world.H * cam.z > viewH() + 1;
  const miniShown = () => (state.mini == null ? !!(world && world.n && cam.z < 0.995 && offScreen()) : state.mini) && !!(fr && fr.map) && !state.full;
  let miniGeo = null;
  const drawMini = () => {
    const show = miniShown(); mini.hidden = !show; if (!show) return;
    const t = theme(); const maxW = 136; const maxH = 96;
    const s = Math.min(maxW / world.W, maxH / world.H); const mw = Math.max(24, world.W * s); const mh = Math.max(16, world.H * s);
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (miniCv.width !== Math.round(mw * dpr) || miniCv.height !== Math.round(mh * dpr)) { miniCv.width = Math.round(mw * dpr); miniCv.height = Math.round(mh * dpr); miniCv.style.width = `${mw}px`; miniCv.style.height = `${mh}px`; }
    miniGeo = { s, mw, mh };
    const ctx = miniCv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, mw, mh);
    ctx.fillStyle = t.bg; ctx.fillRect(0, 0, mw, mh);
    if (world.kind === 'flat') {
      for (let i = 0; i < world.n; i++) { const r = posAt(world, i); const it = leafInfo(i); ctx.globalAlpha = it.sel ? 1 : it.syn ? 0.35 : 0.6; ctx.fillStyle = it.sel ? t.accent : it.syn ? t.muted : it.color; ctx.fillRect(r.x * s, r.y * s, Math.max(1, r.w * s - 0.5), Math.max(1, r.h * s - 0.5)); }
    } else {
      const top = world.L[world.m];
      for (let k = 0; k < world.K; k++) {
        const x = (k % world.C) * (top.w + top.gap) * s; const y = Math.floor(k / world.C) * (top.h + top.gap) * s;
        const first = k * top.span; const n = Math.min(top.span, world.n - first);
        ctx.globalAlpha = 0.85; ctx.fillStyle = t.panel; ctx.fillRect(x, y, Math.max(1, top.w * s), Math.max(1, top.h * s * Math.min(1, n / top.span * 1.0001 + (n < top.span ? 0.1 : 0))));
        ctx.globalAlpha = 1; ctx.strokeStyle = first < world.nReal ? t.accent : t.line; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, top.w * s - 1), Math.max(1, top.h * s - 1));
      }
      const si = indexOf(state.selected);
      if (si >= 0) { const r = posAt(world, si); ctx.fillStyle = t.accent; ctx.beginPath(); ctx.arc(r.x * s + 1, r.y * s + 1, 2.5, 0, 7); ctx.fill(); }
    }
    // The part on screen now.
    ctx.globalAlpha = 1; ctx.strokeStyle = t.text; ctx.lineWidth = 1.5;
    const vx = cam.x * s; const vy = cam.y * s; const vw = viewW() / cam.z * s; const vh = viewH() / cam.z * s;
    if (vw < 4 && vh < 4) { ctx.beginPath(); ctx.arc(vx + vw / 2, vy + vh / 2, 3, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.moveTo(vx + vw / 2 - 6, vy + vh / 2); ctx.lineTo(vx + vw / 2 + 6, vy + vh / 2); ctx.moveTo(vx + vw / 2, vy + vh / 2 - 6); ctx.lineTo(vx + vw / 2, vy + vh / 2 + 6); ctx.stroke(); }
    else ctx.strokeRect(Math.max(0.75, vx), Math.max(0.75, vy), Math.min(mw - 1.5, vw), Math.min(mh - 1.5, vh));
    // Breadcrumbs (nested maps only) and what is actually being drawn.
    const w = whereNow(); const key = world.kind === 'group' ? [world.n, ...w.chain.map((c) => c.first + ':' + c.count)].join('|') : 'flat';
    if (crumbs._key !== key) {
      crumbs._key = key; crumbs.replaceChildren();
      if (world.kind === 'group') {
        const add = (label, act, full) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = full; b.setAttribute('aria-label', full); b.addEventListener('click', act); crumbs.append(b); };
        add(`All ${compact(world.n)}`, () => fitCam(), `All ${fmt(world.n)} threads`);
        for (const c of w.chain) { const sp = document.createElement('span'); sp.textContent = '›'; sp.setAttribute('aria-hidden', 'true'); crumbs.append(sp); add(`${compact(c.first + 1)}–${compact(c.first + c.count)}`, () => zoomToRect(c.r, false), `Threads ${fmt(c.first + 1)}–${fmt(c.first + c.count)}`); }
      }
    }
    crumbs.hidden = world.kind !== 'group';
    const st = lastStats || { live: 0, cards: 0, chips: 0, blocks: 0 };
    const syn = Math.max(0, world.n - world.nReal);
    miniStat.textContent = `On screen: ${st.live} live, ${fmt(st.cards + st.chips + st.blocks)} drawn · of ${compact(world.n)}${syn ? ` (${compact(syn)} synthetic)` : ''}`;
    miniStat.title = `On screen: ${st.live} live pane${st.live === 1 ? '' : 's'}, ${fmt(st.cards)} cards, ${fmt(st.chips)} chips, ${fmt(st.blocks)} blocks, out of ${fmt(world.n)} threads${syn ? ` (${fmt(syn)} synthetic)` : ''}. Nothing off screen is built or drawn.`;
  };
  // Click or drag on the small map to move there.
  miniCv.addEventListener('pointerdown', (e) => {
    if (!miniGeo || e.button !== 0) return; e.preventDefault(); anim = null; pushHist();
    const go = (ev) => { const r = miniCv.getBoundingClientRect(); const wx = (ev.clientX - r.left) / miniGeo.s; const wy = (ev.clientY - r.top) / miniGeo.s; setCam({ z: cam.z, x: wx - viewW() / 2 / cam.z, y: wy - viewH() / 2 / cam.z }); };
    go(e); miniCv.setPointerCapture(e.pointerId);
    const up = () => { miniCv.removeEventListener('pointermove', go); miniCv.removeEventListener('pointerup', up); };
    miniCv.addEventListener('pointermove', go); miniCv.addEventListener('pointerup', up);
  });

  // ---------- map input: scroll, pinch, drag, click, keys ----------
  const hideTip = () => { tip.hidden = true; };
  const showTip = (h, sx, sy) => {
    if (!h) { hideTip(); return; }
    let a; let b;
    if (h.kind === 'leaf') { const it = leafInfo(h.i); a = it.title; b = `${it.syn ? 'Synthetic · ' : ''}Click to zoom in`; }
    else { a = `Threads ${fmt(h.first + 1)}–${fmt(h.first + h.count)}`; const yours = h.first < world.nReal ? Math.min(h.count, world.nReal - h.first) : 0; const deeper = Math.min((viewW() - 24) / h.r.w, (viewH() - 24) / h.r.h) > cam.z * 1.05; b = `${fmt(h.count)} threads${yours ? ` · ${yours} yours` : ''} · synthetic${deeper ? ' · click to zoom in' : ''}`; }
    tip.replaceChildren(); const s1 = document.createElement('strong'); s1.textContent = a; const s2 = document.createElement('small'); s2.textContent = b; tip.append(s1, s2);
    tip.hidden = false;
    const tw = tip.offsetWidth; const tH = tip.offsetHeight;
    tip.style.left = `${clamp(sx + 14, 4, viewW() - tw - 4)}px`; tip.style.top = `${sy + 18 + tH > viewH() - 4 ? sy - tH - 10 : sy + 18}px`;
  };
  const sameHit = (a, b) => (!a && !b) || (a && b && a.kind === b.kind && (a.kind === 'leaf' ? a.i === b.i : a.first === b.first && a.count === b.count));
  const setHover = (h, sx, sy) => {
    const changed = !sameHit(hover, h); hover = h;
    mapCv.classList.toggle('mk-point', !!h && (h.kind === 'leaf' || Math.min((viewW() - 24) / h.r.w, (viewH() - 24) / h.r.h) > cam.z * 1.05));
    showTip(h, sx, sy); if (changed) schedule();
  };
  // A scroll that starts over something that can scroll (a transcript, a code
  // block) stays with it for the whole gesture, like the browser does.
  const canScroll = (el, dx, dy) => {
    const cs = getComputedStyle(el);
    const y = /(auto|scroll)/.test(cs.overflowY) && ((dy > 0 && el.scrollTop < el.scrollHeight - el.clientHeight - 1) || (dy < 0 && el.scrollTop > 0));
    const x = /(auto|scroll)/.test(cs.overflowX) && ((dx > 0 && el.scrollLeft < el.scrollWidth - el.clientWidth - 1) || (dx < 0 && el.scrollLeft > 0));
    return Math.abs(dy) >= Math.abs(dx) ? y : x;
  };
  const wheelOwner = (e) => {
    for (let el = e.target; el && el !== mapEl; el = el.parentElement) if (el.nodeType === 1 && canScroll(el, e.deltaX, e.deltaY)) return 'inner';
    return 'map';
  };
  let latch = null; let lastZoomEv = 0;
  mapEl.addEventListener('wheel', (e) => {
    if (state.full || (drag && drag.moved) || !fr || !fr.map) return;
    const now = performance.now(); const r = mapEl.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); anim = null; hideTip();
      if (now - lastZoomEv > 450) pushHist();
      lastZoomEv = now;
      zoomActive(Math.exp(clamp(-e.deltaY * unit * 0.0075, -0.7, 0.7)), { sx: e.clientX - r.left, sy: e.clientY - r.top });
      return;
    }
    if (!latch || now > latch.until) latch = { to: wheelOwner(e), until: 0 };
    latch.until = now + 220;
    if (latch.to === 'inner') return;
    e.preventDefault(); anim = null; hideTip();
    panBy(e.deltaX * unit, e.deltaY * unit);
  }, { passive: false });
  // Focus or scrollIntoView can scroll an overflow:hidden box behind our back,
  // which would slide the real panes off the drawn map. Turn that into a camera
  // move instead, so the focused thing still comes into view.
  mapEl.addEventListener('scroll', () => {
    const dx = mapEl.scrollLeft; const dy = mapEl.scrollTop; if (!dx && !dy) return;
    mapEl.scrollLeft = 0; mapEl.scrollTop = 0; panBy(dx, dy);
  });
  ui.grid.addEventListener('scroll', () => { ui.grid.scrollLeft = 0; ui.grid.scrollTop = 0; });
  // Scrolling over the map's own bar moves the map too.
  hud.addEventListener('wheel', (e) => {
    if (state.full || !fr || !fr.map) return;
    e.preventDefault(); anim = null; const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) zoomActive(Math.exp(clamp(-e.deltaY * unit * 0.0075, -0.7, 0.7)));
    else panBy(e.deltaX * unit, e.deltaY * unit);
  }, { passive: false });
  // Ctrl/⌘ + scroll elsewhere in the pane area never zooms the page.
  ui.grid.addEventListener('wheel', (e) => { if ((e.ctrlKey || e.metaKey) && !e.defaultPrevented) e.preventDefault(); }, { passive: false });
  // Safari reports pinches as gesture events.
  let g0 = null;
  mapEl.addEventListener('gesturestart', (e) => { e.preventDefault(); anim = null; pushHist(); g0 = { z: cam.z, fz: state.flatZoom || 1 }; });
  mapEl.addEventListener('gesturechange', (e) => {
    if (!g0) return; e.preventDefault(); const r = mapEl.getBoundingClientRect(); const pt = { sx: e.clientX - r.left, sy: e.clientY - r.top };
    const af = zoomFocus(e.scale >= 1 ? 1.01 : 0.99, pt);
    if (world && world.kind === 'flat') { setFlatZoom(g0.fz * e.scale, af.sx, af.sy, false, af.act, af.ptr); return; }
    zoomAt(af.sx, af.sy, (g0.z * e.scale) / cam.z, af.act, af.ptr);
  });
  mapEl.addEventListener('gestureend', (e) => { e.preventDefault(); g0 = null; });
  // Drag the empty background (or middle-drag anywhere) to pan; click a card or block to zoom to it.
  let pan = null;
  const startPan = (e) => {
    e.preventDefault(); anim = null; hideTip();
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, button: e.button };
    try { mapEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  mapCv.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; mapEl.focus({ preventScroll: true }); startPan(e); });
  mapEl.addEventListener('pointerdown', (e) => { if (e.button === 1 && !e.target.closest('.mk-hud, .mk-mini')) startPan(e); }, true);
  mapEl.addEventListener('pointermove', (e) => {
    const r = mapEl.getBoundingClientRect();
    lastPtr = { sx: e.clientX - r.left, sy: e.clientY - r.top };
    if (pan && e.pointerId === pan.id) {
      const dx = e.clientX - pan.x; const dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < 4) return;
      if (!pan.moved) { pan.moved = true; pushHist(); mapEl.classList.add('mk-grabbing'); setHover(null); }
      setCam({ z: cam.z, x: pan.cx - dx / cam.z, y: pan.cy - dy / cam.z });
      return;
    }
    if (e.target !== mapCv) { if (hover) setHover(null); return; }
    const sx = e.clientX - r.left; const sy = e.clientY - r.top;
    setHover(hitAt(sx, sy), sx, sy);
  });
  mapEl.addEventListener('pointerleave', () => { lastPtr = null; });
  const endPan = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const p = pan; pan = null; mapEl.classList.remove('mk-grabbing');
    if (p.moved || p.button !== 0 || e.type === 'pointercancel') return;
    const r = mapEl.getBoundingClientRect(); const h = hitAt(e.clientX - r.left, e.clientY - r.top);
    if (!h || anim) return;
    // A card or block zooms in. It does not select the thread: the shared
    // composer keeps writing to the same place until you click inside a pane.
    if (h.kind === 'leaf') zoomToRect(h.r, true);
    else if (Math.min((viewW() - 24) / h.r.w, (viewH() - 24) / h.r.h) > cam.z * 1.05) zoomToRect(h.r, false);
    setHover(null);
  };
  mapEl.addEventListener('pointerup', endPan);
  mapEl.addEventListener('pointercancel', endPan);
  mapCv.addEventListener('pointerleave', () => { if (!pan) setHover(null); });
  mapCv.addEventListener('dblclick', (e) => {
    const r = mapEl.getBoundingClientRect(); const sx = e.clientX - r.left; const sy = e.clientY - r.top;
    if (hitAt(sx, sy)) return;
    const f = e.shiftKey || e.altKey ? 0.5 : 2; const z1 = clamp(cam.z * f, zMin(), Z_MAX);
    const wx = cam.x + sx / cam.z; const wy = cam.y + sy / cam.z;
    animateTo({ z: z1, x: wx - sx / z1, y: wy - sy / z1 });
  });
  mapEl.addEventListener('keydown', (e) => {
    if (e.target !== mapEl || e.metaKey || e.ctrlKey || e.altKey) return;
    // A flat map settles on whole rows (or columns), so arrows move one line.
    const step = world && world.kind === 'flat' && world.n ? rowStride() : e.shiftKey ? 240 : 60; anim = null;
    if (e.shiftKey && (e.code === 'Digit1' || e.key === '!')) { fitCam(); e.preventDefault(); return; }
    switch (e.key) {
      case 'ArrowUp': panBy(0, -step); break;
      case 'ArrowDown': panBy(0, step); break;
      case 'ArrowLeft': panBy(-step, 0); break;
      case 'ArrowRight': panBy(step, 0); break;
      case 'PageUp': if (sideways()) panBy(-viewW() * 0.9, 0); else panBy(0, -viewH() * 0.9); break;
      case 'PageDown': case ' ': if (sideways()) panBy(viewW() * 0.9, 0); else panBy(0, viewH() * 0.9); break;
      case 'Home': setCam({ z: cam.z, x: 0, y: 0 }); break;
      case 'End': setCam({ z: cam.z, x: world.W, y: world.H }); break;
      case '+': case '=': zoomBy(2); break;
      case '-': case '_': zoomBy(0.5); break;
      case '0': resetCam(); break;
      case 'Backspace': case '[': back(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- the agent background: a sunflower of sunflowers ----------
  // Agents sit on a sunflower spiral around the welcome text; it packs any
  // count evenly. When there are more than fit, each mark is a cluster drawn as
  // a small sunflower of its own. Pinch, Ctrl/⌘ + scroll or click a cluster and
  // it opens into smaller clusters, then single agents with faces, then names.
  // Only marks on screen are drawn, never more than BUDGET a frame.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const FIB = [8, 13, 21, 34, 55, 89, 144, 233, 377];
  const KIDS = 144; const BLOOM = 26; const BUDGET = 14000; const F_MAX = 4e6;
  const HUES = Array.from({ length: 360 }, (_, h) => `hsl(${h} 75% 62%)`);
  // Real members first, then synthetic agents that borrow real faces with a hashed colour.
  const agentSource = (thread) => {
    const real = members(thread).map((m) => { const b = botFor(m); return { name: m.name, seed: b ? b.seed : '', color: b ? b.color : '#8b8b8b', meta: toolLabel(b) }; });
    const n = thread.virtualAgents || real.length; const pool = savedBots(); const R = real.length;
    return {
      n, real: R,
      seedAt: (i) => (i < R ? real[i].seed : pool[hash(i) % pool.length].seed),
      colorAt: (i) => (i < R ? real[i].color : HUES[hash(i) % 360]),
      nameAt: (i) => (i < R ? real[i].name : `Agent ${fmt(i + 1)}`),
      metaAt: (i) => (i < R ? real[i].meta : `Synthetic · looks like ${pool[hash(i) % pool.length].name}`)
    };
  };
  const sprites = new Map();
  const SPRITE_PX = [12, 16, 24, 32, 48, 64, 96, 128];
  const spritePx = (px) => SPRITE_PX.find((s) => s >= px) || 128;
  const sprite = (seed, color, px) => {
    const key = `${seed}|${color}|${px}`; let c = sprites.get(key); if (c) return c;
    if (sprites.size > 800) sprites.clear();
    c = document.createElement('canvas'); c.width = c.height = px; const g = c.getContext('2d');
    const cells = CELLS[seed] || CELLS.__fallback; const cell = px * 0.15; const gap = px * 0.03; const off = (px - (5 * cell + 4 * gap)) / 2;
    g.fillStyle = color;
    for (let n = 0; n < 25; n++) { g.globalAlpha = cells[n] ? 1 : 0.1; g.fillRect(off + (n % 5) * (cell + gap), off + Math.floor(n / 5) * (cell + gap), cell, cell); }
    sprites.set(key, c); return c;
  };
  const fields = new Set();
  let fieldFrame = 0; let fieldLast = 0;
  const clampFc = (c) => { c.z = clamp(c.z, 1, F_MAX); const span = 1 - 1 / c.z; c.u = clamp(c.u, 0, span); c.v = clamp(c.v, 0, span); return c; };
  const zoomText = (z) => (z < 10 ? `${z.toFixed(1)}×` : `${fmt(z)}×`);
  const sizeField = (cv, snug) => {
    const host = cv.closest('.chat-body') || cv.parentElement;
    const W = host.clientWidth; const H = host.clientHeight; const dpr = Math.min(2, devicePixelRatio || 1);
    if (W < 24 || H < 24) { fields.delete(cv); return; }
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const n = cv._src.n; const hole = snug ? 0.3 : 0.4;
    const Rx0 = W / 2 - 8; const Ry0 = H / 2 - 8;
    const room = Math.PI * Rx0 * Ry0 * (1 - hole * hole);
    const fitK = Math.floor(room / (snug ? 22 * 22 : 30 * 30));
    // Few enough: every agent gets a mark. More: a Fibonacci number of clusters,
    // so the clusters only change at a few sizes while the pane is resized.
    const K = n <= Math.max(8, fitK) ? n : FIB.reduce((best, f) => (f <= fitK ? f : best), 8);
    const s = Math.sqrt(room / K);
    const m = Math.min(s * 0.68, snug ? 40 : 64, Math.min(W, H) / 4);
    const prev = cv._f;
    const saved = state.fieldCams.get(cv._tid);
    const fc = prev && prev.n === n && prev.K === K ? prev.fc : saved && saved.n === n && saved.K === K ? saved.fc : { z: 1, u: 0, v: 0 };
    state.fieldCams.set(cv._tid, { n, K, fc });
    cv._f = { W, H, dpr, n, K, s, m, hole, snug, Rx: Math.max(4, Rx0 - m / 2), Ry: Math.max(4, Ry0 - m / 2), R: s * 0.46, named: m >= 34 && n <= 8,
      t: prev ? prev.t : hash(n) % 100, rip: prev ? prev.rip : 0, speed: prev ? prev.speed : 1, ptr: prev ? prev.ptr : null, lens: prev ? prev.lens : 0, fc: clampFc(fc), hot: null, anim: prev ? prev.anim : null };
    host._fieldCv = cv;
    if (!host._fieldHooked) { host._fieldHooked = true; hookField(host); }
    fields.add(cv); drawField(cv, 0); wake(); syncFieldHud(cv);
  };
  const fieldAnimTo = (f, target) => {
    clampFc(target);
    if (motionOff()) { Object.assign(f.fc, target); f.anim = null; return; }
    f.anim = { a: { ...f.fc }, b: target, t0: performance.now(), ms: Math.min(900, 320 + 50 * Math.abs(Math.log2(target.z / f.fc.z))) };
  };
  const stepFieldAnim = (f) => {
    const an = f.anim; if (!an) return;
    const u = Math.min(1, (performance.now() - an.t0) / an.ms); const e = 1 - Math.pow(1 - u, 3);
    const a = an.a; const b = an.b; const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * e);
    const ax = a.u * f.W; const ay = a.v * f.H; const bx = b.u * f.W; const by = b.v * f.H; let x; let y;
    if (Math.abs(b.z - a.z) > 1e-9 * Math.max(a.z, b.z)) {
      const Px = (bx * b.z - ax * a.z) / (b.z - a.z); const Py = (by * b.z - ay * a.z) / (b.z - a.z);
      const sx = (Px - ax) * a.z; const sy = (Py - ay) * a.z; x = Px - sx / z; y = Py - sy / z;
    } else { x = ax + (bx - ax) * e; y = ay + (by - ay) * e; }
    f.fc.z = z; f.fc.u = x / f.W; f.fc.v = y / f.H;
    if (u >= 1) { Object.assign(f.fc, b); f.anim = null; }
  };
  const fieldZoomAt = (f, sx, sy, factor) => {
    const fc = f.fc; const z1 = clamp(fc.z * factor, 1, F_MAX);
    const fx = fc.u * f.W + sx / fc.z; const fy = fc.v * f.H + sy / fc.z;
    fc.u = (fx - sx / z1) / f.W; fc.v = (fy - sy / z1) / f.H; fc.z = z1; clampFc(fc); f.anim = null;
  };
  const openCluster = (cv, h) => {
    const f = cv._f; const z1 = clamp(f.fc.z * (Math.min(f.W, f.H) * 0.36) / Math.max(1, h.Rs), 1, F_MAX);
    const fx = f.fc.u * f.W + h.sx / f.fc.z; const fy = f.fc.v * f.H + h.sy / f.fc.z;
    fieldAnimTo(f, { z: z1, u: (fx - f.W / 2 / z1) / f.W, v: (fy - f.H / 2 / z1) / f.H }); wake();
  };
  const explorable = (f) => f.n > f.K || f.fc.z > 1.001;
  const hookField = (host) => {
    let fd = null;
    host.addEventListener('pointermove', (e) => {
      const cv = host._fieldCv; const f = cv && cv.isConnected && cv._f; if (!f) return;
      const r = cv.getBoundingClientRect();
      if (fd && e.pointerId === fd.id) {
        const dx = e.clientX - fd.x; const dy = e.clientY - fd.y;
        if (!fd.moved && Math.hypot(dx, dy) > 4) fd.moved = true;
        if (fd.moved && f.fc.z > 1.001) { f.anim = null; f.fc.u = fd.u - dx / (f.fc.z * f.W); f.fc.v = fd.v - dy / (f.fc.z * f.H); clampFc(f.fc); host.classList.add('mk-field-grab'); }
      }
      f.ptr = { x: e.clientX - r.left, y: e.clientY - r.top }; wake();
    });
    host.addEventListener('pointerleave', () => { const cv = host._fieldCv; if (cv && cv._f) cv._f.ptr = null; wake(); });
    host.addEventListener('pointerdown', (e) => {
      const cv = host._fieldCv; const f = cv && cv.isConnected && cv._f;
      if (!f || e.button !== 0 || e.target.closest('button, a, input, textarea, select, .mk-field-hud')) return;
      fd = { id: e.pointerId, x: e.clientX, y: e.clientY, u: f.fc.u, v: f.fc.v, moved: false };
      if (f.fc.z > 1.001) { try { host.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    });
    const up = (e) => {
      if (!fd || e.pointerId !== fd.id) return;
      const was = fd; fd = null; host.classList.remove('mk-field-grab');
      const cv = host._fieldCv; const f = cv && cv.isConnected && cv._f; if (!f) return;
      if (!was.moved && e.type === 'pointerup' && f.hot && f.hot.count > 1 && explorable(f)) openCluster(cv, f.hot);
      syncFieldHud(cv);
    };
    host.addEventListener('pointerup', up); host.addEventListener('pointercancel', up);
    host.addEventListener('wheel', (e) => {
      const cv = host._fieldCv; const f = cv && cv.isConnected && fields.has(cv) && cv._f;
      if (!f || !explorable(f)) return; // a few agents: the map (or page) gets the scroll
      const r = cv.getBoundingClientRect(); const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); fieldZoomAt(f, e.clientX - r.left, e.clientY - r.top, Math.exp(clamp(-e.deltaY * unit * 0.0075, -0.7, 0.7))); }
      else if (f.fc.z > 1.001) { e.preventDefault(); e.stopPropagation(); f.anim = null; f.fc.u += e.deltaX * unit / (f.fc.z * f.W); f.fc.v += e.deltaY * unit / (f.fc.z * f.H); clampFc(f.fc); }
      else return;
      syncFieldHud(cv); wake();
    }, { passive: false });
  };
  const syncFieldHud = (cv) => {
    const f = cv._f; const empty = cv.parentElement; if (!f || !empty) return;
    const zoomed = f.fc.z > 1.001;
    empty.classList.toggle('mk-field-zoomed', f.fc.z > 1.15);
    let hudEl = $(':scope > .mk-field-hud', empty);
    if (!explorable(f)) { if (hudEl) hudEl.remove(); return; }
    if (!hudEl) {
      hudEl = document.createElement('div'); hudEl.className = 'mk-field-hud';
      const txt = document.createElement('span'); txt.setAttribute('role', 'status');
      const l1 = document.createElement('b'); const l2 = document.createElement('small'); txt.append(l1, l2);
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Reset'; btn.title = 'Show every agent again';
      btn.addEventListener('click', (e) => { e.stopPropagation(); const c = empty.querySelector('canvas.mk-field'); if (!c || !c._f) return; fieldAnimTo(c._f, { z: 1, u: 0, v: 0 }); wake(); });
      hudEl.append(txt, btn); empty.append(hudEl);
    }
    const src = cv._src; const key = `${zoomText(f.fc.z)}|${f.n}|${f.K}`;
    if (hudEl._key === key) return; hudEl._key = key;
    const [l1, l2] = hudEl.firstChild.children;
    l1.textContent = `${fmt(f.n)} agents · ${fmt(src.real)} real, the rest synthetic`;
    l2.textContent = zoomed ? `Zoomed ${zoomText(f.fc.z)} · drag to move, pinch out or Reset to go back` : 'Pinch, or click a cluster, to open it';
    hudEl.lastChild.hidden = !zoomed;
  };
  const glyph = (st, sx, sy, Rs, a0, count, alpha) => {
    if (alpha < 0.01) return; const ctx = st.ctx; const src = st.src; ctx.globalAlpha = alpha;
    if (Rs < 3) { ctx.fillStyle = src.colorAt(a0); const d = Math.max(1.5, Rs * 1.4); ctx.fillRect(sx - d / 2, sy - d / 2, d, d); return; }
    const dots = Rs < 8 ? 5 : 13; const d = Math.max(1.2, Rs * (dots === 5 ? 0.42 : 0.27));
    for (let j = 0; j < dots; j++) {
      const rho = Math.sqrt((j + 0.5) / dots) * Rs * 0.8; const ang = j * GOLDEN;
      ctx.fillStyle = src.colorAt(a0 + Math.floor(j * count / dots));
      ctx.fillRect(sx + rho * Math.cos(ang) - d / 2, sy + rho * Math.sin(ang) - d / 2, d, d);
    }
  };
  const fieldMark = (st, sx, sy, ms, Rs, a0, count, alpha) => {
    const f = st.f; const reach = Math.max(ms * 0.5, Rs) + 2;
    if (sx + reach < 0 || sy + reach < 0 || sx - reach > f.W || sy - reach > f.H || st.budget <= 0) return;
    st.budget--;
    const ctx = st.ctx; const src = st.src;
    const near = f.ptr ? (sx - f.ptr.x) ** 2 + (sy - f.ptr.y) ** 2 : Infinity;
    if (count <= 1) {
      if (near < Math.max(reach, 7) ** 2 && near < st.hotD) { st.hotD = near; st.hot = { sx, sy, ms, Rs, a0, count }; }
      const color = src.colorAt(a0); ctx.globalAlpha = alpha;
      if (ms >= 9) ctx.drawImage(sprite(src.seedAt(a0), color, spritePx(ms * st.dpr)), sx - ms / 2, sy - ms / 2, ms, ms);
      else { ctx.fillStyle = color; const d = Math.max(1.5, ms); ctx.fillRect(sx - d / 2, sy - d / 2, d, d); }
      if ((f.named || ms >= 30) && st.named < 40) { st.named++; ctx.globalAlpha = Math.min(0.95, alpha * 1.6); ctx.fillStyle = color; ctx.font = '600 12px system-ui, -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(src.nameAt(a0), sx, sy + ms / 2 + 4); }
      return;
    }
    const t = st.budget > KIDS * 2 ? smooth(Rs, BLOOM, BLOOM * 2) : 0;
    if (t < 0.5 && near < Math.max(Rs + 2, 9) ** 2 && near < st.hotD) { st.hotD = near; st.hot = { sx, sy, ms, Rs, a0, count }; }
    if (t < 1) glyph(st, sx, sy, Rs, a0, count, alpha * (1 - 0.85 * t));
    if (t <= 0) return;
    const k = Math.min(count, KIDS); const R = Rs * 0.92;
    const sc = Math.sqrt(Math.PI * R * R / k); const mc = sc * 0.62; const Rc = sc * 0.46;
    for (let j = 0; j < k; j++) {
      const rho = Math.sqrt((j + 0.5) / k) * R; const ang = j * GOLDEN;
      const c0 = a0 + Math.floor(j * count / k); const c1 = a0 + Math.floor((j + 1) * count / k);
      fieldMark(st, sx + rho * Math.cos(ang), sy + rho * Math.sin(ang), mc, Rc, c0, c1 - c0, alpha * t);
    }
  };
  const fieldTip = (st) => {
    const { ctx, f, src } = st; const h = st.hot; const t = theme();
    const one = h.count <= 1; const syn = h.a0 + h.count > src.real;
    const line1 = one ? src.nameAt(h.a0) : `${fmt(h.count)} agents`;
    const line2 = one ? src.metaAt(h.a0) : `${fmt(h.a0 + 1)}–${fmt(h.a0 + h.count)}${syn ? ' · synthetic' : ''} · click to open`;
    const sz = Math.max(h.ms, h.count > 1 ? h.Rs * 2 : 0, 14);
    ctx.font = '600 12px system-ui, -apple-system, sans-serif'; const w1 = ctx.measureText(line1).width;
    ctx.font = '11px system-ui, -apple-system, sans-serif'; const w = Math.max(w1, ctx.measureText(line2).width) + 14;
    const bx = Math.min(f.W - w - 4, Math.max(4, h.sx - w / 2)); const by = h.sy + sz / 2 + 6 > f.H - 40 ? h.sy - sz / 2 - 40 : h.sy + sz / 2 + 6;
    ctx.globalAlpha = 0.94; ctx.fillStyle = t.bg; ctx.strokeStyle = t.line; ctx.beginPath(); ctx.roundRect(bx, by, w, 34, 6); ctx.fill(); ctx.stroke();
    if (h.count > 1) { ctx.globalAlpha = 0.9; ctx.strokeStyle = t.text; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(h.sx, h.sy, Math.max(4, h.Rs), 0, 7); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = one ? src.colorAt(h.a0) : t.text; ctx.font = '600 12px system-ui, -apple-system, sans-serif'; ctx.fillText(line1, bx + 7, by + 4);
    ctx.fillStyle = t.muted; ctx.font = '11px system-ui, -apple-system, sans-serif'; ctx.fillText(line2, bx + 7, by + 19);
  };
  const drawField = (cv, dt) => {
    const f = cv._f; const src = cv._src; const ctx = cv.getContext('2d');
    stepFieldAnim(f);
    const still = motionOff(); const zoomed = f.fc.z > 1.001;
    if (zoomed) f.speed = 0; else f.speed += ((f.ptr ? 0.2 : 1) - f.speed) * Math.min(1, dt * 4);
    f.lens += ((f.ptr && !zoomed ? 1 : 0) - f.lens) * Math.min(1, dt * 6 || 1);
    if (!still) { f.t += dt * f.speed; f.rip += dt; }
    ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0); ctx.clearRect(0, 0, f.W, f.H);
    const Z = f.fc.z; const ox = f.fc.u * f.W; const oy = f.fc.v * f.H; const cx = f.W / 2; const cy = f.H / 2;
    const rot = still ? 0 : (f.t / 240) * 2 * Math.PI; // one turn every 4 minutes, paused while zoomed in
    const boost = smooth(Math.log2(Z), 0, 3); // exploring: the faint watermark firms up
    const base = (f.snug ? 0.24 : 0.18) + 0.55 * boost; const L = Math.max(36, f.s * 2.4);
    const st = { ctx, f, src, budget: BUDGET, named: 0, hot: null, hotD: Infinity, dpr: f.dpr };
    for (let k = 0; k < f.K; k++) {
      const rho = Math.sqrt(f.hole * f.hole + (1 - f.hole * f.hole) * (k + 0.5) / f.K);
      const ang = k * GOLDEN + rot + (still || zoomed ? 0 : 0.22 * Math.sin(f.t * 0.11) * (1 - rho));
      let x = cx + rho * f.Rx * Math.cos(ang); let y = cy + rho * f.Ry * Math.sin(ang);
      let scale = 1; let alpha = base * (still ? 1 : 0.62 + 0.38 * Math.sin(f.rip * 1.1 - rho * 9));
      if (f.ptr && f.lens > 0.01) {
        const dx = x - f.ptr.x; const dy = y - f.ptr.y; const d = Math.hypot(dx, dy);
        if (d < L) { const q = (1 - d / L) * f.lens; const push = q * q * f.s * 0.55 / (d || 1); x += dx * push; y += dy * push; scale += 0.7 * q; alpha += 0.45 * q; }
      }
      const a0 = Math.floor(k * f.n / f.K); const a1 = Math.floor((k + 1) * f.n / f.K);
      fieldMark(st, (x - ox) * Z, (y - oy) * Z, f.m * scale * Z, f.R * scale * Z, a0, a1 - a0, Math.min(0.95, alpha));
    }
    f.hot = st.hot;
    if (st.hot && f.ptr) fieldTip(st);
    ctx.globalAlpha = 1;
  };
  // One loop for every field. It sleeps when nothing moves, and skips hidden fields.
  const tick = (now) => {
    const dt = fieldLast ? Math.min(0.1, (now - fieldLast) / 1000) : 0; fieldLast = now;
    let busy = false;
    for (const cv of fields) {
      if (!cv.isConnected) { fields.delete(cv); continue; }
      if (!cv.offsetParent) continue;
      const f = cv._f; const was = !!f.anim;
      drawField(cv, dt);
      if (was && !f.anim) syncFieldHud(cv); else if (f.anim) syncFieldHud(cv);
      if (!motionOff() || f.anim || Math.abs((f.ptr ? 1 : 0) - f.lens) > 0.01 || f.ptr) busy = true;
    }
    if (busy) fieldFrame = requestAnimationFrame(tick); else { fieldFrame = 0; fieldLast = 0; }
  };
  const wake = () => { if (!fieldFrame && fields.size) fieldFrame = requestAnimationFrame(tick); };
  stillMotion.addEventListener('change', wake);

  // ---------- fitting panes to their size ----------
  const fitPane = (p, light) => {
    const w = p._w || p.offsetWidth; const h = p._h || p.offsetHeight;
    const tile = w < 260 || h < 200;
    if (tile !== p.classList.contains('mk-tile')) {
      if (tile) { p._tileAnchor = anchorOf(p); p.classList.add('mk-tile'); }
      else { p.classList.remove('mk-tile'); applyAnchor(p, p._tileAnchor || { pinned: true }); p._tileAnchor = null; }
    }
    p.dataset.mkRoom = w >= 480 && h >= 460 ? 'roomy' : 'snug';
    if (light && p._fitW && Math.abs(p._fitW - w) < 16 && Math.abs(p._fitH - h) < 16) return;
    p._fitW = w; p._fitH = h;
    const cv = $('canvas.mk-field', p); if (cv) sizeField(cv, p.dataset.mkRoom === 'snug');
    fitHead($('.pane-head', p));
    fitEmpty(p);
  };
  const fitAll = () => {
    for (const p of panes.values()) if (p.isConnected && !p.classList.contains('mk-leaving')) fitPane(p, false);
    fitChips(ui.chips);
  };
  // Live updates while a divider moves: one layout per frame, no glide.
  let frame = 0;
  const liveLayout = () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; place(); fitAll(); }); };

  // ---------- Mockup only: scale test ----------
  // Threads: adds that many synthetic threads to the map, after your own.
  // Agents: adds a "Scale test" thread up front with that many agents and no messages.
  const scaleBtn = document.createElement('button'); scaleBtn.type = 'button'; scaleBtn.className = 'badge mk-scale-btn';
  scaleBtn.setAttribute('aria-haspopup', 'menu'); scaleBtn.setAttribute('aria-expanded', 'false');
  scaleBtn.title = 'Mockup only: add synthetic threads or agents to try very large counts';
  const syncScaleBtn = () => {
    const bits = []; if (state.scaleThreads) bits.push(`+${fmt(state.scaleThreads)} synthetic threads`); if (state.scaleAgents) bits.push(`a thread with ${fmt(state.scaleAgents)} agents`);
    scaleBtn.textContent = 'Scale test ▾'; scaleBtn.classList.toggle('mk-on', bits.length > 0);
    scaleBtn.title = bits.length ? `Mockup only. On: ${bits.join(' and ')}` : 'Mockup only: add synthetic threads or agents to try very large counts';
  };
  const short = (n) => n >= 1e9 ? `${n / 1e9}B` : n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n);
  ui.reset.after(scaleBtn);
  let scaleMenu = null;
  const closeScale = () => { if (scaleMenu) { scaleMenu.remove(); scaleMenu = null; scaleBtn.setAttribute('aria-expanded', 'false'); } };
  const setScaleThreads = (n) => {
    state.scaleThreads = n; state.synClosed = []; synCache.clear();
    if (isSyn(state.selected)) state.selected = openIds()[0] || state.selected;
    if (isSyn(state.full)) state.full = null;
    render(true); syncScaleBtn();
    if (n) { requestAnimationFrame(() => fitCam()); toast(`${fmt(n)} synthetic threads added after yours. Only what is on screen is drawn.`); }
  };
  const setScaleAgents = (n) => {
    state.scaleAgents = n;
    state.added = state.added.filter((t) => !t.virtualAgents); state.order = state.order.filter((id) => id !== 'mk-scale');
    panes.get('mk-scale')?.remove(); panes.delete('mk-scale'); livePanes.delete('mk-scale'); state.fieldCams.delete('mk-scale');
    // The scale thread goes away: hand the composer back to the thread you had before.
    if (state.selected === 'mk-scale') state.selected = (state.scalePrev && T(state.scalePrev) && !state.closed.has(state.scalePrev)) ? state.scalePrev : openIds()[0];
    if (state.full === 'mk-scale') state.full = null;
    if (n) { if (state.selected !== 'mk-scale') state.scalePrev = state.selected; const t = { id: 'mk-scale', title: `Scale test · ${fmt(n)} agents`, members: savedBots().map((b) => ({ id: b.id, name: b.name })), messages: [], virtualAgents: n }; state.added.push(t); state.order = [t.id, ...state.order]; state.selected = t.id; state.closed.delete(t.id); }
    render(true); syncScaleBtn();
    if (n) reveal('mk-scale');
  };
  scaleBtn.addEventListener('click', (e) => {
    e.stopPropagation(); if (scaleMenu) { closeScale(); return; }
    closeMenu(); closePicker();
    const el = document.createElement('span'); el.className = 'pane-menu deck-menu mk-scale-menu'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', 'Scale test');
    const head = (text) => { const h = document.createElement('span'); h.className = 'mk-menu-head'; h.setAttribute('role', 'presentation'); h.textContent = text; el.append(h); };
    const item = (label, on, act) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(on));
      const l = document.createElement('span'); l.className = 'label'; l.textContent = label; b.append(l);
      if (on) { const k = document.createElement('span'); k.className = 'keys'; k.textContent = '✓'; b.append(k); }
      b.addEventListener('click', () => { closeScale(); act(); scaleBtn.focus(); }); el.append(b);
    };
    head('Synthetic threads in the map');
    for (const n of [0, 100, 10000, 1e6, 1e9]) item(n ? `+${fmt(n)}` : 'None, just yours', state.scaleThreads === n, () => setScaleThreads(n));
    const sp = document.createElement('span'); sp.className = 'pane-menu-sep'; sp.setAttribute('role', 'separator'); el.append(sp);
    head('New thread with synthetic agents');
    for (const n of [0, 13, 144, 10000, 1e6, 1e9]) item(n ? `${fmt(n)} agents` : 'None', state.scaleAgents === n, () => setScaleAgents(n));
    document.body.append(el);
    const r = scaleBtn.getBoundingClientRect();
    el.style.position = 'fixed'; el.style.inset = `${r.bottom + 4}px auto auto ${Math.max(8, r.left)}px`;
    scaleMenu = el; scaleBtn.setAttribute('aria-expanded', 'true');
    $('button[aria-checked="true"]', el).focus();
  });
  document.addEventListener('pointerdown', (e) => { if (scaleMenu && !scaleMenu.contains(e.target) && e.target !== scaleBtn) closeScale(); }, true);

  // ---------- sidebar ----------
  const renderSidebar = () => {
    $$('.pane-row', ui.ws).forEach((el) => el.remove());
    ui.count.textContent = String(allThreads().length);
    for (const t of allThreads()) {
      const row = tpl('mk-tpl-row');
      row.dataset.paneRow = t.id;
      row.classList.toggle('focused', t.id === state.selected);
      row.classList.toggle('mk-multi-selected', hasMulti() && state.multiSelected.has(t.id));
      row.classList.toggle('on-canvas', !state.closed.has(t.id));
      const title = $('.pane-row-title', row);
      title.textContent = t.title; title.setAttribute('aria-label', `Rename ${t.title}`);
      $$('.row-acts button', row).forEach((b) => b.setAttribute('aria-label', b.getAttribute('aria-label').replace('Sample thread', t.title)));
      row.addEventListener('click', (e) => {
        if (e.target.closest('.row-acts')) { toast('Mockup: sidebar row menus are not wired'); return; }
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); toggleMulti(t.id); return; }
        fromSidebar(t.id);
      });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') fromSidebar(t.id); });
      ui.ws.append(row);
    }
  };
  // Picking a thread in the sidebar selects it (that is an explicit choice) and
  // brings its pane into view, zooming only if it is too small to use.
  const fromSidebar = (id) => {
    if (state.closed.has(id)) { state.closed.delete(id); state.order = [...state.order.filter((x) => x !== id), id]; }
    if (state.full) state.full = id;
    select(id, true);
    render();
    reveal(id);
  };
  const flash = (p) => { p.classList.add('mk-flash'); setTimeout(() => p.classList.remove('mk-flash'), 700); };

  // Tagged drafts use native noneditable inline chips; the textarea remains the
  // backing model and the untagged editor, preserving ordinary draft behavior.
  let richEditor=null;
  let attachmentDrag=null;
  let attachmentDeletionUndo=null;
  const dropMarker=document.createElement('span');
  dropMarker.className='mk-file-drop-caret';dropMarker.hidden=true;document.body.append(dropMarker);
  const clearAttachmentDrag=()=>{attachmentDrag=null;dropMarker.hidden=true;};
  const bindAttachmentDrag=(element,att,source=null)=>{
    element.draggable=!state.multiPending.size;
    element.addEventListener('dragstart',e=>{
      if(state.multiPending.size){e.preventDefault();return;}
      let currentSource=source;
      if(source!==null){const prefix=document.createRange();prefix.selectNodeContents(richEditor);prefix.setEndBefore(element);currentSource=richText(prefix.cloneContents()).length;}
      attachmentDrag={id:att.id,source:currentSource};
      e.dataTransfer.setData('text/plain',att.label);
      e.dataTransfer.effectAllowed=source===null?'copy':'move';
      closeAtPicker();
    });
    element.addEventListener('dragend',clearAttachmentDrag);
  };
  const attachmentDropRange=(e)=>{
    let range=document.caretRangeFromPoint?.(e.clientX,e.clientY);
    if(!range || !richEditor.contains(range.startContainer))return null;
    const chip=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement)?.closest('.mk-thread-tag, .mk-attachment-tag');
    if(chip){const box=chip.getBoundingClientRect();range=document.createRange();if(e.clientX<box.left+box.width/2)range.setStartBefore(chip);else range.setStartAfter(chip);range.collapse(true);}
    return range;
  };
  const richText = (root) => {
    let out='';
    for(const node of root.childNodes) {
      if(node.nodeType===3) out+=node.textContent;
      else if(node.nodeType===1) {
        if(node.dataset.threadId!==undefined) out+=threadToken(node.dataset.threadId);
        else if(node.dataset.attachmentId!==undefined) out+=attachmentToken(node.dataset.attachmentId);
        else if(node.tagName==='BR') out+='\n';
        else { if(['DIV','P'].includes(node.tagName) && out && !out.endsWith('\n'))out+='\n'; out+=richText(node); }
      }
    }
    return out;
  };
  const richCaret = () => {
    const sel=window.getSelection();
    if(!sel.rangeCount || !richEditor.contains(sel.anchorNode))return ui.input.value.length;
    const range=sel.getRangeAt(0).cloneRange();range.selectNodeContents(richEditor);range.setEnd(sel.focusNode,sel.focusOffset);
    return richText(range.cloneContents()).length;
  };
  const chipClipboardType='application/x-apex-deck-draft';
  const readableClipboardText=text=>readableAttachments(text).replace(/⟦thread:([^⟧]*)⟧/g,(_,id)=>'#'+(T(id)?.title||'Missing thread'));
  // Plain text never promotes a look-alike internal token into an actual chip.
  const plainClipboardText=text=>text.replaceAll('⟦','［').replaceAll('⟧','］');
  const editorRange=()=>{
    const sel=window.getSelection();if(!sel.rangeCount)return null;
    const range=sel.getRangeAt(0);
    return richEditor.contains(range.startContainer)&&richEditor.contains(range.endContainer)?range:null;
  };
  const editorSelection=()=>{
    if(richEditor.hidden)return document.activeElement===ui.input?{text:ui.input.value,start:ui.input.selectionStart,end:ui.input.selectionEnd}:null;
    const range=editorRange();if(!range)return null;
    const prefix=range.cloneRange();prefix.selectNodeContents(richEditor);prefix.setEnd(range.startContainer,range.startOffset);
    const start=richText(prefix.cloneContents()).length;
    return {text:richText(richEditor),start,end:start+richText(range.cloneContents()).length};
  };
  const replaceEditorSelection=text=>{
    const selection=editorSelection();if(!selection)return;
    const {text:before,start:at,end}=selection;
    ui.input.value=before.slice(0,at)+text+before.slice(end);
    ui.input.setSelectionRange(at+text.length,at+text.length);onInput();syncRichEditor(true,at+text.length);
  };
  const copyEditorSelection=(e,cut=false)=>{
    const selection=editorSelection();if(!selection||selection.start===selection.end||!e.clipboardData||state.multiPending.size)return;
    const text=selection.text.slice(selection.start,selection.end);
    // Do not delete a cut unless both clipboard representations were written.
    try {
      e.clipboardData.setData('text/plain',readableClipboardText(text));
      e.clipboardData.setData(chipClipboardType,JSON.stringify({version:1,scope:state.clipboardScope,text}));
    } catch {e.preventDefault();return;}
    e.preventDefault();
    if(cut){const before=state.multiDraft;replaceEditorSelection('');attachmentDeletionUndo={before,after:state.multiDraft,offset:richCaret()};}
  };
  const pasteEditorClipboard=e=>{
    e.preventDefault();if(!e.clipboardData||state.multiPending.size||!editorSelection())return;
    let text=plainClipboardText(e.clipboardData.getData('text/plain'));
    try {
      const payload=JSON.parse(e.clipboardData.getData(chipClipboardType));
      if(payload.version===1&&payload.scope===state.clipboardScope&&typeof payload.text==='string'&&
        [...payload.text.matchAll(/⟦thread:([^⟧]*)⟧/g)].every(m=>!!T(m[1]))&&
        attachmentRefs(payload.text).every(id=>state.multiAttachmentCache.has(id)))text=payload.text;
    } catch { /* External text and malformed payloads stay readable text. */ }
    const images=[...e.clipboardData.files].filter(file=>file.type.startsWith('image/'));
    if(images.length){
      text=images.map(file=>{
        const number=++attachmentSequence;
        const att={id:'att-'+number,label:'Image'+number,name:file.name||`pasted-image-${number}.png`,file,previewUrl:URL.createObjectURL(file),dest:new Set()};
        state.multiAttachmentCache.set(att.id,att);return attachmentToken(att.id);
      }).join(' ')+' ';
    }
    replaceEditorSelection(text);
  };
  const placeRichCaret = (offset) => {
    const range=document.createRange(); let remaining=offset, placed=false;
    for(const n of richEditor.childNodes) {
      const length=n.nodeType===3?n.textContent.length:(n.dataset.attachmentId!==undefined?attachmentToken(n.dataset.attachmentId):threadToken(n.dataset.threadId)).length;
      if(remaining<=length) {
        if(n.nodeType===3)range.setStart(n,remaining);
        else if(remaining===0)range.setStartBefore(n); else range.setStartAfter(n);
        placed=true;break;
      }
      remaining-=length;
    }
    if(!placed){range.selectNodeContents(richEditor);range.collapse(false);}else range.collapse(true);
    const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);richEditor.focus();
  };
  const syncRichEditor = (focus=false,caret) => {
    const text=ui.input.value;
    const active=hasMulti() && text.includes('⟦thread:');
    if(!richEditor) {
      richEditor=document.createElement('div');richEditor.className='mk-rich-input';richEditor.contentEditable='true';
      richEditor.setAttribute('role','textbox');richEditor.setAttribute('aria-label','Message with thread tags');richEditor.setAttribute('aria-multiline','true');
      richEditor.hidden=true;ui.input.after(richEditor);
      richEditor.addEventListener('dragover',e=>{
        if(!attachmentDrag || state.multiPending.size)return;
        e.preventDefault();e.dataTransfer.dropEffect=attachmentDrag.source===null?'copy':'move';
        const range=attachmentDropRange(e);const box=range?.getClientRects()[0];
        dropMarker.hidden=!box;
        if(box){dropMarker.style.left=box.left+'px';dropMarker.style.top=box.top+'px';dropMarker.style.height=Math.max(18,box.height)+'px';}
      });
      richEditor.addEventListener('dragleave',()=>{dropMarker.hidden=true;});
      richEditor.addEventListener('drop',e=>{
        if(!attachmentDrag)return;
        e.preventDefault();
        const range=attachmentDropRange(e);const drag=attachmentDrag;clearAttachmentDrag();
        if(!range || state.multiPending.size)return;
        const prefix=range.cloneRange();prefix.selectNodeContents(richEditor);prefix.setEnd(range.startContainer,range.startOffset);
        let at=richText(prefix.cloneContents()).length;let text=richText(richEditor);const token=attachmentToken(drag.id);
        if(drag.source!==null){
          if(text.slice(drag.source,drag.source+token.length)!==token)return;
          if(at>=drag.source && at<=drag.source+token.length)return;
          text=text.slice(0,drag.source)+text.slice(drag.source+token.length);
          if(at>drag.source)at-=token.length;
        }
        ui.input.value=text.slice(0,at)+token+text.slice(at);ui.input.setSelectionRange(at+token.length,at+token.length);
        onInput();syncRichEditor(true,at+token.length);
      });
      richEditor.addEventListener('input',()=>{
        const offset=richCaret();ui.input.value=richText(richEditor);ui.input.setSelectionRange(offset,offset);onInput();
        if(!richEditor.hidden && !richEditor.contains(window.getSelection().anchorNode))placeRichCaret(offset);
      });
      richEditor.addEventListener('click',()=>{ const c=richCaret();ui.input.setSelectionRange(c,c);onComposerAtTrigger(ui.input.value,c); });
      richEditor.addEventListener('keydown',(e)=>{
        if(e.isComposing)return;
        if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!e.shiftKey&&attachmentDeletionUndo&&state.multiDraft===attachmentDeletionUndo.after){
          e.preventDefault();const saved=attachmentDeletionUndo;attachmentDeletionUndo=null;
          ui.input.value=saved.before;onInput();syncRichEditor(true,saved.offset);return;
        }
        if(e.key==='Backspace'||e.key==='Delete') {
          const sel=window.getSelection();
          if(sel.isCollapsed) {
            const anchor=sel.anchorNode;
            let chip=(anchor.nodeType===1?anchor:anchor.parentElement)?.closest('.mk-thread-tag, .mk-attachment-tag');
            if(!chip && anchor.nodeType===3 && (e.key==='Backspace'?sel.anchorOffset===0:sel.anchorOffset===anchor.length)) chip=e.key==='Backspace'?anchor.previousSibling:anchor.nextSibling;
            if(!chip && anchor===richEditor) chip=richEditor.childNodes[sel.anchorOffset+(e.key==='Backspace'?-1:0)];
            if(chip?.matches?.('.mk-thread-tag, .mk-attachment-tag')) {
              e.preventDefault();const range=document.createRange();range.selectNodeContents(richEditor);range.setEndBefore(chip);const offset=richText(range.cloneContents()).length;
              const before=state.multiDraft;const isAttachment=chip.dataset.attachmentId!==undefined;
              chip.remove();if(isAttachment)attachmentDeletionUndo={before,after:richText(richEditor),offset};richEditor.dispatchEvent(new Event('input'));if(!richEditor.hidden)placeRichCaret(offset);else {ui.input.focus();ui.input.setSelectionRange(offset,offset);}return;
            }
          }
        }
        const c=richCaret();ui.input.setSelectionRange(c,c);
        if(e.key==='Enter'&&!e.shiftKey) {e.preventDefault();if(state.multiPicker)state.multiPicker.el.querySelector('button:not(:disabled)')?.click();else send();}
        if(e.key==='Escape'&&state.multiPicker){closeAtPicker();e.stopPropagation();}
        if(e.key==='ArrowDown'&&state.multiPicker){e.preventDefault();state.multiPicker.el.querySelector('button:not(:disabled)')?.focus();}
      });
      richEditor.addEventListener('copy',e=>copyEditorSelection(e));
      richEditor.addEventListener('cut',e=>copyEditorSelection(e,true));
      richEditor.addEventListener('paste',pasteEditorClipboard);
      // Cutting every chip reveals the textarea. Keep the same clipboard contract
      // there so the draft can be pasted back without losing its attachment cache.
      ui.input.addEventListener('copy',e=>{if(hasMulti())copyEditorSelection(e);});
      ui.input.addEventListener('cut',e=>{if(hasMulti())copyEditorSelection(e,true);});
      ui.input.addEventListener('paste',e=>{if(hasMulti())pasteEditorClipboard(e);});
    }
    const returningFocus=!active && !richEditor.hidden && document.activeElement===richEditor;
    richEditor.hidden=!active;ui.input.style.display=active?'none':'';
    richEditor.contentEditable=state.multiPending.size?'false':'true';
    richEditor.setAttribute('aria-readonly',String(state.multiPending.size>0));
    if(!active) { if(returningFocus)ui.input.focus(); return; }
    const parsed=parseThreadSlices(text);
    if(richText(richEditor)!==text || richEditor.querySelectorAll('.mk-thread-tag').length!==parsed.tags.length || richEditor.querySelectorAll('.mk-attachment-tag').length!==attachmentRefs(text).length || focus) {
      richEditor.replaceChildren();let at=0;
      const allTags=[...parsed.tags,...[...text.matchAll(/⟦file:([^⟧]*)⟧/g)].map(m=>({id:m[1],at:m.index,len:m[0].length,file:true}))].sort((a,b)=>a.at-b.at);
      for(const tag of allTags) {
        richEditor.append(document.createTextNode(text.slice(at,tag.at)));
        const chip=document.createElement('span');chip.className='mk-thread-tag';chip.contentEditable='false';chip.dataset.threadId=tag.id;
        if(tag.file){const att=state.multiAttachments.find(a=>a.id===tag.id);delete chip.dataset.threadId;chip.dataset.attachmentId=tag.id;chip.className='mk-attachment-tag';chip.textContent='▧ '+(att?.label||'Missing file');chip.title=(att?.name||'Missing attachment')+' · Drag between words to move';if(att)bindAttachmentDrag(chip,att,tag.at);}
        else {chip.textContent='#'+(T(tag.id)?.title||'Unresolved thread');chip.title=T(tag.id)?.title||'Unresolved thread';}
        richEditor.append(chip);at=tag.at+tag.len;
      }
      richEditor.append(document.createTextNode(text.slice(at)));
    }
    richEditor.setAttribute('aria-invalid',String(parsed.errors.length>0 || parsed.duplicates.length>0 || parsed.unresolved.length>0));
    for(const chip of richEditor.querySelectorAll('.mk-thread-tag')) {
      chip.classList.toggle('mk-bad',parsed.duplicates.includes(chip.dataset.threadId)||!T(chip.dataset.threadId));
      chip.textContent='#'+(T(chip.dataset.threadId)?.title||'Unresolved thread');
    }
    if(focus)placeRichCaret(caret??text.length);
  };

  // ---------- composer ----------
  const makeChip = (m, who) => {
    const b = botFor(m);
    const c = tpl('mk-tpl-chip');
    const chip = $('.chip', c);
    chip.classList.toggle('to', m.name === who);
    chip.style.setProperty('--who', b ? b.color : '#8b8b8b');
    paintIdenticon($('.identicon', c), b ? b.seed : '', b ? b.color : '#8b8b8b');
    const btn = $('.chip-name', c);
    btn.dataset.mkName = m.name; btn.setAttribute('aria-label', `${m.name}: idle · ${toolLabel(b)} · mention agent`); btn.title = `${m.name}: idle · ${toolLabel(b)}`;
    $('.participant-status', c).setAttribute('aria-label', `${m.name}: idle`);
    $('.chip-label', c).textContent = m.name;
    const meta2 = $('.chip-meta', c); if (meta2) meta2.textContent = toolLabel(b);
    const kick = $('.chip-kick', c); kick.setAttribute('aria-label', `Kick ${m.name}`); kick.title = `Kick ${m.name}`;
    btn.addEventListener('click', () => { const v = ui.input.value; ui.input.value = (v && !v.endsWith(' ') ? v + ' ' : v) + '@' + m.name.toLowerCase() + ' '; onInput(); ui.input.focus(); });
    kick.addEventListener('click', () => toast('Mockup: Kick is not wired'));
    return c;
  };
  const renderComposer = () => {
    const t = T(state.selected);
    if (!t) return;
    const val = hasMulti() ? state.multiDraft : (state.drafts.get(t.id) || '');
    if (ui.input.value !== val) ui.input.value = val;
    autosize();
    const attachmentButton=$('#mk-shared .composer-plus');
    if(attachmentButton){attachmentButton.setAttribute('aria-label',hasMulti()?'Add mock attachment':'Files, tools, commands and mentions');attachmentButton.title=hasMulti()?'Add mock attachment at cursor':'';attachmentButton.disabled=!!(hasMulti()&&state.multiPending.size);if(hasMulti())attachmentButton.removeAttribute('aria-haspopup');else attachmentButton.setAttribute('aria-haspopup','dialog');}
    ui.to.replaceChildren();
    $('#mk-shared .mk-att-panel')?.remove();
    const tag = document.createElement('span'); tag.className='mk-new'; tag.textContent='new';
    const label = document.createElement('span'); label.className='mk-to-label'; label.textContent='To';
    if (!hasMulti()) {
      const who = lastBotName(t);
      ui.input.placeholder = who ? `Message ${who}… # threads · @ agents` : 'Add a model to start';
      const dot = document.createElement('span'); dot.className='dot idle';
      const name = document.createElement('strong'); name.textContent = t.title;
      const meta = document.createElement('span'); meta.className='mk-to-meta'; meta.textContent = `${t.synthetic?'scale test':'apex-deck'} · ${botCount(agentTotal(t))}`;
      ui.to.append(tag,label,dot,name,meta);
      ui.to.title='The shared composer writes to the selected pane. Click to show it.';
      const sh=document.getElementById('mk-shared'); if(sh) sh.classList.remove('mk-multi');
      $$('.chip-wrap',ui.chips).forEach((el)=>el.remove());
      const before=ui.chips.querySelector('.quick-add-wrap');
      for (const m of members(t)) ui.chips.insertBefore(makeChip(m,who),before);
      ui.input.disabled=false;
    } else {
      const plan = computeMultiPlan();
      const ids = plan.ids;
      const explicitOverall = explicitMentions(state.multiDraft);
      ui.input.placeholder = explicitOverall.length ? `Message @${explicitOverall[0]} in ${ids.length} threads… Type # for threads, @ for agents` : `Message ${ids.length} threads… Type # for threads, @ for agents`;
      const sh=document.getElementById('mk-shared'); if(sh) sh.classList.add('mk-multi');
      // Counts per recipient (respecting overrides and slice explicits)
      const counts = new Map(); let bad=0;
      for (const p of plan.plans) {
        if (p.isCommand) continue;
        if (p.isDup || p.rec.missing.length || !members(p.thread).length) { bad++; continue; }
        // Even when draft empty, show who would answer (last @)
        const who = p.rec.agent || lastBotName(p.thread) || '?';
        if (who && who!=='?') counts.set(who,(counts.get(who)||0)+1);
      }
      const parts=[...counts].map(([who,n])=> n>1? `${who} ×${n}`: who);
      if (bad) parts.push(`${bad} can't receive`);
      if (plan.dupIds.length) parts.push(`${plan.dupIds.length} dup tag`);
      const commandCount=plan.plans.filter(p=>p.isCommand).length;
      if(commandCount) parts.push(`${commandCount} ${commandCount===1?'command':'commands'}`);
      if(state.multiAttachments.length) parts.push(`${state.multiAttachments.length} ${state.multiAttachments.length===1?'file':'files'}`);
      const countLine=document.createElement('div'); countLine.className='mk-to-count'; countLine.classList.toggle('mk-warn', bad>0 || plan.dupIds.length>0);
      countLine.setAttribute('role','button'); countLine.tabIndex=0; countLine.setAttribute('aria-expanded', String(!state.multiCollapsed));
      countLine.title = state.multiCollapsed?'Show every recipient and slice preview':'Hide the list';
      const strong=document.createElement('strong'); strong.textContent=`${ids.length} ${ids.length===1?'thread':'threads'}`;
      const meta=document.createElement('span'); meta.className='mk-to-meta'; meta.textContent=`· ${parts.join(', ')}`;
      const caret=document.createElement('span'); caret.className='mk-multi-toggle'; caret.setAttribute('aria-hidden','true'); caret.textContent=state.multiCollapsed?'▾':'▴';
      countLine.append(strong,meta,caret);
      const flip=()=>{state.multiCollapsed=!state.multiCollapsed; renderComposer();};
      countLine.addEventListener('click',flip);
      countLine.addEventListener('keydown',(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); flip(); }});
      ui.to.append(tag,label,countLine);
      if (!state.multiCollapsed) {
        const listEl=document.createElement('div'); listEl.className='mk-multi-list';
        for (const p of plan.plans) {
          const thr=p.thread;
          const none=!members(thr).length;
          const row=document.createElement('div');
          row.className='mk-multi-row' + (p.rec.missing.length||none||p.isDup||p.noText?' mk-bad':'');
          if (p.isDup) row.title='Same thread tagged twice';
          const title=document.createElement('button'); title.type='button'; title.className='mk-mr-title'; title.textContent=thr.title; title.title=`Show ${thr.title}`;
          title.addEventListener('click',()=>reveal(p.id));
          const agentBtn=document.createElement('button'); agentBtn.type='button'; agentBtn.className='mk-mr-agent mk-mr-agent-btn';
          if (p.isCommand) {
            agentBtn.textContent=`→ ${p.outgoing} (command)`; agentBtn.disabled=true;
          } else if (p.rec.missing.length) {
            const em=document.createElement('em'); em.textContent=`@${p.rec.missing.join(', @')} isn't in this thread`; agentBtn.append(em);
          } else if (none) {
            const em=document.createElement('em'); em.textContent='No agents yet, add one to send'; agentBtn.append(em);
          } else {
            const who=p.rec.agent||lastBotName(thr)||'?';
            const b=document.createElement('b'); b.textContent=who;
            const prefix=document.createElement('span'); prefix.textContent='→ ';
            agentBtn.append(prefix,b);
            if(explicitMentions(p.rawSlice).length && !p.isCommand) {const n=document.createElement('span');n.className='mk-mr-note';n.textContent=' (from text)';agentBtn.append(n);}
            else if (p.rec.override) { const n=document.createElement('span'); n.className='mk-mr-note'; n.textContent=p.rec.explicit.length===1 && p.rec.explicit[0]===p.rec.agent.toLowerCase() ? ' (this send)' : ` (instead of ${p.rec.explicit.length ? '@'+p.rec.explicit.join(', @') : 'last @'})`; agentBtn.append(n); }
            else if (!explicitMentions(p.rawSlice).length && !p.isCommand) { const n=document.createElement('span'); n.className='mk-mr-note'; n.textContent=' (last @)'; agentBtn.append(n); }
          }
          agentBtn.title='Click to choose agent for this thread (this send only)';
          agentBtn.disabled=p.isCommand || state.multiPending.size>0 || explicitMentions(p.rawSlice).length>0;
          if(explicitMentions(p.rawSlice).length)agentBtn.title='Recipient comes from the typed @mention. Edit the mention to change it.';
          agentBtn.addEventListener('click',(e)=>{ e.stopPropagation(); openAgentMenu(p.id, agentBtn); });
          const rm=document.createElement('button'); rm.type='button'; rm.className='mk-mr-x'; rm.textContent='×'; rm.title=`Remove ${thr.title}`; rm.setAttribute('aria-label',`Remove ${thr.title} from this message`);
          rm.disabled=state.multiPending.size>0;
          rm.addEventListener('click',()=>{
            removeThreadFromDraft(p.id);
            renderComposer();syncMultiOutlines();renderSidebar();schedule();
          });
          row.append(title,agentBtn,rm);
          // Only problems need a second line; the composer already displays the text.
          if (p.isDup || p.noText || p.commandBlocked) {
            const prev=document.createElement('div'); prev.className='mk-slice-preview';
            const badge=document.createElement('span'); badge.className='mk-slice-badge ' + (p.isCommand?'mk-cmd':''); badge.textContent = p.isCommand ? (p.commandBlocked ? 'blocked command · separate UI required' : '/command · thread handler') : (plan.parsed.hasTags ? 'slice' : 'full prompt');
            const txt=document.createElement('span'); txt.className='mk-slice-text';
            txt.textContent = p.isDup ? '⚠ duplicate thread tag — remove one' : p.noText ? 'nothing to send to this thread' : p.outgoing;
            prev.append(badge,txt);
            row.append(prev);
          }
          // attachment destinations for this row
          if (state.multiAttachments.length) {
            for (const att of state.multiAttachments) {
              if (!att.dest.has(p.id)) continue;
              const attEl=document.createElement('span'); attEl.className='mk-att-dest'; attEl.textContent=`📎 ${att.label}`; attEl.title=att.name;
              row.insertBefore(attEl,rm);
            }
          }
          listEl.append(row);
        }
        ui.to.append(listEl);
      }
        // The stack shares the action row; its popover sits above the composer.
        const attPanel=document.createElement('div'); attPanel.className='mk-att-panel';
        if(state.multiAttachments.length){
          const stack=document.createElement('button');stack.type='button';stack.className='mk-att-stack';
          stack.setAttribute('aria-expanded',String(!!state.multiAttachmentExpanded));
          stack.setAttribute('aria-label',`Preview ${state.multiAttachments.length} attachments`);
          const thumbs=document.createElement('span');thumbs.className='mk-att-thumbs';thumbs.setAttribute('aria-hidden','true');
          for(const [i,att] of state.multiAttachments.slice(0,3).entries()){
            const thumb=document.createElement('span');thumb.className='mk-att-thumb';thumb.style.setProperty('--thumb-index',i);thumb.textContent=att.label;thumb.title=att.name;if(att.previewUrl){thumb.style.backgroundImage=`url("${att.previewUrl}")`;thumb.style.backgroundSize='cover';}thumbs.append(thumb);
          }
          const caption=document.createElement('span');caption.textContent=`${state.multiAttachments.length} ${state.multiAttachments.length===1?'file':'files'} ${state.multiAttachmentExpanded?'▴':'▾'}`;
          stack.append(thumbs,caption);stack.onclick=()=>{state.multiAttachmentExpanded=!state.multiAttachmentExpanded;renderComposer();};attPanel.append(stack);
        }
        const attList=document.createElement('div');attList.className='mk-att-popover';attList.hidden=!state.multiAttachmentExpanded;
        attList.setAttribute('aria-label','Attachments');
        for(const att of state.multiAttachments) {
          const row=document.createElement('div');row.className='mk-att-row';

          const insert=document.createElement('button');insert.type='button';insert.className='mk-att-insert';insert.textContent='▧ '+att.label;insert.title=`Insert ${att.name} at cursor`;insert.disabled=state.multiPending.size>0;
          bindAttachmentDrag(insert,att);
          const preview=document.createElement('span');preview.className='mk-att-preview';preview.setAttribute('role','img');preview.setAttribute('aria-label',`${att.label}: mock image preview`);preview.textContent=att.label+' · Mock image';
          if(att.previewUrl){const image=document.createElement('img');image.src=att.previewUrl;image.alt=att.name;image.style.cssText='width:100%;height:100%;object-fit:cover';preview.replaceChildren(image);preview.setAttribute('aria-label',att.name);}
          insert.onpointerdown=()=>{if(richEditor?.contains(window.getSelection()?.anchorNode)){const at=richCaret();ui.input.setSelectionRange(at,at);}};insert.onclick=()=>insertAttachment(att);
          const status=document.createElement('span');status.className='mk-att-dests';status.textContent=`${att.name} → ${[...att.dest].map(id=>T(id)?.title||'Missing thread').join(', ')}`;
          const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',`Remove ${att.label}`);remove.disabled=state.multiPending.size>0;remove.onclick=()=>{state.multiDraft=state.multiDraft.split(attachmentToken(att.id)).join('');state.multiAttachments=state.multiAttachments.filter(a=>a!==att);state.multiAttachmentCache.delete(att.id);if(att.previewUrl)URL.revokeObjectURL(att.previewUrl);attachmentDeletionUndo=null;ui.input.value=state.multiDraft;onInput();};
          row.append(preview,insert,status,remove);attList.append(row);
        }
        if(state.multiAttachments.length) {
          attPanel.append(attList);
          const pill=$('#mk-shared .tldr-pill');pill.before(attPanel);
          const box=$('#mk-shared .composer-box').getBoundingClientRect();
          attList.style.bottom=`${innerHeight-box.top+6}px`;
          attList.style.right=`${Math.max(8,innerWidth-box.right)}px`;
          attList.style.maxHeight=`${Math.max(60,box.top-12)}px`;
        }
      const failDemo=document.createElement('label'); failDemo.className='mk-fail-demo';
      const failCheck=document.createElement('input'); failCheck.type='checkbox'; failCheck.checked=state.multiFailNext.size>0;
      failCheck.onchange=()=>{state.multiFailNext.clear();if(failCheck.checked && plan.ids[1])state.multiFailNext.add(plan.ids[1]);};
      failDemo.append(failCheck,document.createTextNode(' Simulate failure in second destination (mock only)')); if(!state.multiCollapsed) ui.to.append(failDemo);
      if(plan.parsed.unresolved.length) { const warning=document.createElement('div'); warning.className='mk-multi-hint mk-warn'; warning.setAttribute('role','status'); warning.textContent='Unresolved thread tag — remove it or choose a thread from #.';ui.to.append(warning); }
      if(state.multiAttachments.some((a)=>[...a.dest].some((id)=>!plan.ids.includes(id) || plan.plans.find((p)=>p.id===id)?.isCommand))) {const warning=document.createElement('div');warning.className='mk-multi-hint mk-warn';warning.setAttribute('role','status');warning.textContent='Attachments cannot target command slices or unselected threads. Choose message destinations explicitly.';ui.to.append(warning);}
      // warnings
      if (plan.dupIds.length) {
        const hint=document.createElement('div'); hint.className='mk-multi-hint mk-warn'; hint.setAttribute('role','status');
        hint.textContent = `Duplicate thread tag: ${plan.dupIds.map((id)=>T(id)?.title||id).join(', ')}. Remove duplicate #thread tags to send.`;
        ui.to.append(hint);
      } else {
        const miss = plan.plans.filter((p)=>p.rec.missing.length);
        if (miss.length) {
          const hint=document.createElement('div'); hint.className='mk-multi-hint mk-warn'; hint.setAttribute('role','status');
          const names = [...new Set(miss.flatMap((p)=>p.rec.missing))].join(', @');
          hint.textContent = `@${names} isn't in ${miss.length} thread(s). Edit the @mention or remove those thread tags.`;
          ui.to.append(hint);
        }
      }
      for(const message of plan.parsed.errors) {
        const hint=document.createElement('div');hint.className='mk-multi-hint mk-warn';hint.setAttribute('role','status');hint.textContent=message;ui.to.append(hint);
      }
      // Results of last send
      if (state.multiResults.size) {
        for (const [id, st] of state.multiResults) {
          const r=document.createElement('div'); r.className='mk-multi-hint ' + (st==='ok'?'':'mk-warn'); r.textContent = st==='ok' ? `✓ Sent to ${T(id)?.title}` : `✗ Failed to ${T(id)?.title} — will retry only failed`;
          ui.to.append(r);
        }
        const retry=document.createElement('button'); retry.type='button'; retry.className='mk-retry'; retry.textContent='Retry failed only'; retry.disabled=!state.multiPending.size;
        retry.addEventListener('click',()=>retryFailed());
        ui.to.append(retry);
      }
      syncRoutes();
      $$('.chip-wrap',ui.chips).forEach((el)=>el.remove());
      ui.chips.style.display='none';
    }
    if(state.multiUndo) {
      const undo=document.createElement('button');undo.type='button';undo.textContent='Removed · Undo';undo.setAttribute('aria-label','Undo removal');
      undo.addEventListener('click',()=>{state.multiDraft=state.multiUndo.draft;for(const saved of state.multiUndo.attachments){const att=state.multiAttachments.find(a=>a.id===saved.id);if(att)att.dest=new Set(saved.dest);}state.multiUndo=null;syncSelectionFromDraft();renderComposer();syncMultiOutlines();renderSidebar();schedule();});ui.to.append(undo);
    }
    if (!hasMulti()) { ui.chips.style.opacity=''; ui.chips.style.display=''; }
    // Send disabled logic with safeguards
    if (hasMulti()) {
      const plan=computeMultiPlan();
      let block=!state.multiDraft.trim();
      if (!plan.ids.length || plan.parsed.errors.length || plan.dupIds.length || plan.parsed.unresolved.length || state.multiPending.size) block=true;
      if(state.multiAttachments.some((a)=> !a.dest.size || [...a.dest].some((id)=>!plan.ids.includes(id) || plan.plans.find((p)=>p.id===id)?.isCommand))) block=true;
      for (const p of plan.plans) {
        if (!members(p.thread).length) { block=true; break; }
        if (!p.isCommand && p.rec.missing.length) { block=true; break; }
        if (p.isDup || p.commandBlocked) { block=true; break; }
      }
      // A thread with no slice keeps Send clickable: the click fails loudly (shake + red flash) instead.
      const emptyIds=plan.plans.filter((p)=>p.noText).map((p)=>p.id);
      // slash command as whole slice is allowed per new spec when it is a slice; block only when whole draft is slash and no tags
      if (!plan.parsed.hasTags && state.multiDraft.trim().startsWith('/')) block=true;
      ui.send.disabled=block;
      ui.input.disabled=state.multiPending.size>0;
      ui.send.title=state.multiPending.size ? 'Retry or discard the failed batch first' : block ? 'Resolve routing, empty slices and attachment destinations before Send' : emptyIds.length ? 'No message yet for '+emptyIds.map((id)=>T(id)?.title||id).join(', ') : 'Send to the listed destinations (mockup only)';
    } else {
      ui.send.disabled=!ui.input.value.trim();
    }
    if(state.multiPending.size) {
      const pending=document.createElement('div');pending.className='mk-pending';pending.setAttribute('role','status');
      for(const p of state.multiPending.values()) {
        const label=document.createElement('strong');label.textContent=`Failed payload preserved: ${T(p.id)?.title||p.id} → ${p.isCommand?'Thread command handler':p.agent}`;
        const text=document.createElement('pre');text.textContent=p.outgoing;
        const attachments=document.createElement('span');attachments.textContent=`Attachments: ${p.attachments.join(', ')||'none'}`;pending.append(label,text,attachments);
      }
      if(!hasMulti()) {const retry=document.createElement('button');retry.type='button';retry.className='mk-retry';retry.textContent='Retry failed only';retry.onclick=retryFailed;pending.append(retry);}
      const discard=document.createElement('button');discard.type='button';discard.className='mk-discard';discard.textContent='Discard failed batch';
      discard.onclick=()=>{state.multiPending.clear();state.multiResults.clear();finishMockBatch();};pending.append(discard);ui.to.append(pending);
    }
    syncRichEditor();
  };
  const autosize = () => { ui.input.style.height = '44px'; ui.input.style.height = Math.min(200, Math.max(44, ui.input.scrollHeight)) + 'px'; };
  const onInput = (e) => {
    if (hasMulti()) {
      state.multiDraft = ui.input.value;
      state.multiUndo=null;
      syncSelectionFromDraft();
      syncMultiOutlines();renderSidebar();
      const caret = ui.input.selectionStart || ui.input.value.length;
      onComposerAtTrigger(ui.input.value, caret);
    } else {
      state.drafts.set(state.selected, ui.input.value);
      onComposerAtTrigger(ui.input.value,ui.input.selectionStart ?? ui.input.value.length);
    }
    renderComposer(); autosize();
  };
  const flashMissing = (ids) => {
    ids.forEach((id) => {
      const p = panes.get(id); if (!p) return;
      p.classList.add('mk-multi-missing');
      setTimeout(() => p.classList.remove('mk-multi-missing'), 900);
    });
  };
  let attachmentSequence=0;
  const addMockAttachment = () => {
    if(!hasMulti() || state.multiPending.size)return;
    const number=++attachmentSequence;const att={id:'att-'+number,label:'Image'+number,name:`file-${number}.png`,dest:new Set()};
    state.multiAttachments.push(att);insertAttachment(att);
  };
  const insertAttachment = (att) => {
    const at=richEditor && richEditor.contains(window.getSelection()?.anchorNode)?richCaret():(ui.input.selectionStart??state.multiDraft.length);
    const token=attachmentToken(att.id);
    state.multiDraft=state.multiDraft.slice(0,at)+token+' '+state.multiDraft.slice(at);
    ui.input.value=state.multiDraft;ui.input.setSelectionRange(at+token.length+1,at+token.length+1);onInput();syncRichEditor(true,at+token.length+1);
  };
  const batchKey = (plan) => JSON.stringify({draft:state.multiDraft, ids:plan.ids, overrides:[...state.multiOverrides], attachments:state.multiAttachments.map((a)=>[a.id,[...a.dest]])});
  const deliverMockSlice = (payload, retry=false) => {
    // An explicit, deterministic mock failure never appends a successful transcript entry.
    if (!retry && state.multiFailNext.has(payload.id)) {
      state.multiFailNext.delete(payload.id); state.multiResults.set(payload.id,'fail'); state.multiPending.set(payload.id,payload); return;
    }
    const list=state.sent.get(payload.id)||[];
    list.push({speaker:'You',text:payload.outgoing});
    list.push({speaker:payload.isCommand?'Thread command handler':payload.agent,text:payload.isCommand ? '(Mock) /compact executed by this thread’s command handler.' : `(Mock) routed to ${payload.agent}${payload.attachments.length ? ' · attachments: '+payload.attachments.join(', ') : ''}`});
    state.sent.set(payload.id,list); state.multiResults.set(payload.id,'ok'); state.multiPending.delete(payload.id);
    if(paneOf(payload.id)) fillTranscript(paneOf(payload.id),T(payload.id));
  };
  const finishMockBatch = () => {
    if(!state.multiPending.size) {
      state.multiDraft=''; ui.input.value=''; state.multiSelected=new Set();state.multiUndo=null;syncMultiOutlines();renderSidebar(); state.multiOverrides.clear(); state.multiAttachments=[];for(const att of state.multiAttachmentCache.values())if(att.previewUrl)URL.revokeObjectURL(att.previewUrl);state.multiAttachmentCache.clear();state.clipboardScope=Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');attachmentDeletionUndo=null; state.multiPreviewed=null;
    }
    closeAtPicker(); closeAgentMenu(); schedule(); renderComposer();
  };
  const retryFailed = () => {
    for(const payload of [...state.multiPending.values()]) deliverMockSlice(payload,true);
    finishMockBatch(); toast('Retried only the failed slices (mockup only).');
  };
  // Send with a thread that has no slice: refuse, shake Send, briefly flash each empty thread red.
  const emptySay=document.createElement('span');emptySay.className='mk-sr';emptySay.setAttribute('role','status');emptySay.id='mk-empty-say';document.body.append(emptySay);
  const restartClass=(el,cls,ms)=>{if(!el)return;el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls);clearTimeout(el._mkT?.[cls]);(el._mkT||(el._mkT={}))[cls]=setTimeout(()=>el.classList.remove(cls),ms);};
  const rejectEmptySlices = (ids) => {
    restartClass(ui.send,'mk-send-shake',500);
    for(const id of ids) {
      restartClass(panes.get(id),'mk-empty-flash',1200);
      for(const chip of document.querySelectorAll('#mk-shared .mk-thread-tag')) if(chip.dataset.threadId===id) restartClass(chip,'mk-empty-flash',1200);
    }
    emptySay.textContent='';emptySay.textContent='Not sent. No message for '+ids.map((id)=>T(id)?.title||id).join(', ')+'.';
  };
  const sendMulti = () => {
    const plan=computeMultiPlan();
    const blocked=!plan.ids.length || plan.parsed.errors.length || plan.dupIds.length || plan.parsed.unresolved.length || state.multiPending.size ||
      plan.plans.some((p)=>p.isDup || p.commandBlocked || !members(p.thread).length || (!p.isCommand && p.rec.missing.length)) ||
      (!plan.parsed.hasTags && state.multiDraft.trim().startsWith('/')) ||
      state.multiAttachments.some((a)=>!a.dest.size || [...a.dest].some((id)=>!plan.ids.includes(id) || plan.plans.find((p)=>p.id===id)?.isCommand));
    if(blocked) { state.multiCollapsed=false; renderComposer(); toast('Resolve the blocked destinations before Send.'); return; }
    const emptyIds=plan.plans.filter((p)=>p.noText).map((p)=>p.id);
    if(emptyIds.length) { rejectEmptySlices(emptyIds); return; }
    state.multiResults.clear();
    for(const p of plan.plans) deliverMockSlice({id:p.id,outgoing:p.outgoing,isCommand:p.isCommand,agent:p.rec.agent,attachments:state.multiAttachments.filter((a)=>a.dest.has(p.id)).map((a)=>a.name)});
    finishMockBatch();
    toast(state.multiPending.size ? 'Some slices failed. Their exact payloads are preserved for Retry failed only.' : 'All slices sent inside this mockup only.');
  };
  const send = () => {
    const text = hasMulti() ? state.multiDraft.trim() : ui.input.value.trim();
    if (!text) return;
    if (hasMulti()) { sendMulti(text); return; }
    const t = T(state.selected);
    if (!members(t).length) { openAdd(t.id); toast('Add an agent to this thread first.'); return; }
    const list = state.sent.get(t.id) || []; list.push({ speaker: 'You', text }); state.sent.set(t.id, list);
    state.drafts.set(t.id, ''); ui.input.value = ''; onInput();
    fillTranscript(paneOf(t.id), t);
    schedule();
    toast(`Added to “${t.title}” in this page only. Nothing was sent.`);
  };
  ui.input.addEventListener('input', onInput);
  ui.input.addEventListener('click', ()=>{ { const c=ui.input.selectionStart||0; onComposerAtTrigger(ui.input.value,c);} });
  ui.input.addEventListener('keyup', (e)=>{ if(e.key==='Escape'){ closeAtPicker(); return; } { const c=ui.input.selectionStart||0; if(e.key==='@' || /[A-Za-z0-9 _-]/.test(e.key)) onComposerAtTrigger(ui.input.value,c); } });
  ui.input.addEventListener('keydown', (e) => {
    if(e.key==='ArrowDown' && state.multiPicker){e.preventDefault();state.multiPicker.el.querySelector('button:not(:disabled)')?.focus();return;}
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      if (state.multiPicker && state.multiPicker.el) { e.preventDefault(); const first = state.multiPicker.el.querySelector('button:not(:disabled)'); if(first) first.click(); return; }
      e.preventDefault(); send();
    }
    if (e.key==='Escape' && state.multiPicker) { closeAtPicker(); e.stopPropagation(); }
  });
  ui.send.addEventListener('click', send);
  ui.to.addEventListener('click', (e)=>{ if(e.target.closest('.mk-to-count')) return; reveal(state.selected); });
  $$('#mk-shared button').forEach((b) => { if (b !== ui.send && !b.closest('.chip-wrap') && !b.closest('.quick-add-wrap')) { b.addEventListener('pointerdown',e=>{if(b.classList.contains('composer-plus')&&hasMulti())e.preventDefault();}); b.addEventListener('click', () => { if(b.classList.contains('composer-plus')&&hasMulti()){addMockAttachment();return;} if (b.classList.contains('tldr-pill')) { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); return; } toast('Mockup: this composer control is not wired'); }); } });

  // ---------- details ----------
  const renderDetails = () => {
    const t = T(state.selected); if (!t) return;
    ui.detTitle.textContent = t.title;
    ui.detSub.textContent = `${t.synthetic ? 'scale test' : 'apex-deck'} · ${botCount(agentTotal(t))}`;
    $$('.details-bot', ui.detBots).forEach((el) => el.remove());
    const add = ui.detBots.querySelector('.quick-add-wrap');
    for (const m of members(t)) {
      const b = botFor(m);
      const a = tpl('mk-tpl-detbot');
      paintIdenticon($('.identicon', a), b ? b.seed : '', b ? b.color : '#8b8b8b');
      const strong = $('.details-bot-copy strong', a); strong.textContent = m.name; strong.style.setProperty('--agent-color', b ? b.color : '#8b8b8b');
      $('.details-bot-copy .muted', a).textContent = b ? agentMeta(b) : 'Agent';
      if (b && b.persona) a.title = `Persona: ${b.persona}`;
      $('.pane-menu-wrap button', a).setAttribute('aria-label', `Actions for ${m.name}`);
      const usage = $('.usage-card', a); if (usage) usage.setAttribute('aria-label', `Usage for ${m.name}`);
      ui.detBots.insertBefore(a, add);
    }
  };

  // ---------- actions ----------
  // Selecting is light: classes, composer and Details follow; panes don't move under the pointer.
  const select = (id, quiet) => {
    if (hasMulti() && !quiet) {
      // Plain click on a pane already in multi keeps multi (per review); only clicking outside multi clears
      if (state.multiSelected.has(id)) {
        // keep multi, just change focus inside multi
        state.selected = id;
        for (const [pid, p] of panes) p.classList.toggle('focused', pid === id);
        renderSidebar(); renderComposer(); renderDetails(); requestAnimationFrame(() => fitChips(ui.chips));
        schedule();
        return;
      }
      clearMulti();
    }
    if (state.selected === id && !quiet) {
      for (const [pid, p] of panes) p.classList.toggle('focused', pid === id);
      return;
    }
    state.selected = id;
    if (quiet) return;
    for (const [pid, p] of panes) p.classList.toggle('focused', pid === id);
    renderSidebar(); renderComposer(); renderDetails(); requestAnimationFrame(() => fitChips(ui.chips));
    schedule();
  };
  const toggleFull = (id) => {
    if (hasMulti()) clearMulti();
    state.selected = id; state.full = state.full === id ? null : id; render();
  };
  const closePane = (id) => {
    if (isSyn(id)) {
      const s = synNum(id); if (!state.synClosed.includes(s)) { state.synClosed.push(s); state.synClosed.sort((a, b) => a - b); }
      synCache.delete(id); const p = panes.get(id); if (p) { p.remove(); panes.delete(id); } livePanes.delete(id);
    } else state.closed.add(id);
    if (state.full === id) state.full = null;
    if (state.multiSelected && state.multiSelected.has(id)) {
      state.multiSelected.delete(id);
      if (state.multiSelected.size <= 1) clearMulti();
    }
    if (state.selected === id) state.selected = openIds()[0] || id;
    render(true); toast(isSyn(id) ? 'Closed. Reset brings synthetic threads back.' : 'Closed. The thread stays in the sidebar; click it to reopen.');
  };

  // ⋯ menu: the real menu, positioned like Deck's (fixed, under the button, right edges aligned).
  let menu = null;
  const closeMenu = () => { if (menu) { menu.el.remove(); menu.btn.setAttribute('aria-expanded', 'false'); menu = null; } };
  const openMenu = (id, btn) => {
    const again = menu && menu.id === id; closeMenu(); if (again) return;
    select(id);
    const el = tpl('mk-tpl-menu');
    document.body.append(el);
    const r = btn.getBoundingClientRect();
    el.style.position = 'fixed'; el.style.inset = `${r.bottom + 4}px auto auto 0px`;
    el.style.inset = `${r.bottom + 4}px auto auto ${Math.max(8, r.right - el.offsetWidth)}px`;
    btn.setAttribute('aria-expanded', 'true');
    menu = { id, el, btn };
    $$('button', el).forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.key; closeMenu();
      if (key === 'popout') toast('Mockup: Open in new window is not wired');
      else toast(`Mockup: ${b.querySelector('.label').textContent.replace('…', '')} is not wired`);
    }));
    $('button', el).focus();
  };
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.el.contains(e.target) && e.target !== menu.btn) closeMenu();
    if (pickerOpen && !ui.picker.contains(e.target)) closePicker();
    if (state.multiAgentMenu && state.multiAgentMenu.el && !state.multiAgentMenu.el.contains(e.target) && !(e.target.closest && e.target.closest('.mk-route, .mk-mr-agent-btn, .mk-att-pick'))) closeAgentMenu();
    if (state.multiPicker && state.multiPicker.el && !state.multiPicker.el.contains(e.target) && e.target.id !== 'mk-input' && !e.target.closest('.mk-rich-input')) closeAtPicker();
  }, true);

  // Layout picker: the real popover with five choices: Horizontal, Vertical,
  // Even grid, Focus left, Focus right. Horizontal (full-width rows, scroll
  // down) and Vertical (full-height columns, scroll sideways) are the grid's
  // band arrangements inside: state.layout 'grid' with state.gridDir 'h' / 'v'.
  let pickerOpen = null;
  const CHOICES = {
    horizontal: { name: 'Horizontal', layout: 'grid', dir: 'h' },
    vertical: { name: 'Vertical', layout: 'grid', dir: 'v' },
    grid: { name: 'Even grid', layout: 'grid', dir: 'grid' },
    left: { name: 'Focus left', layout: 'left' },
    right: { name: 'Focus right', layout: 'right' },
  };
  const layoutKey = () => (state.layout !== 'grid' ? state.layout : state.gridDir === 'h' ? 'horizontal' : state.gridDir === 'v' ? 'vertical' : 'grid');
  const layoutName = () => CHOICES[layoutKey()].name;
  // Moving into the grid or a band from anything else starts it at its usual
  // zoom, scrolled to the start.
  const setLayout = (key) => {
    const c = CHOICES[key];
    if (c.layout === 'grid' && (state.layout !== 'grid' || state.gridDir !== c.dir)) { state.flatZoom = 1; state.cams.delete('grid|flat'); }
    state.layout = c.layout; if (c.dir) state.gridDir = c.dir;
  };
  const syncPicker = () => { ui.pickerBtn.setAttribute('aria-label', `Pane layout: ${layoutName()}`); ui.pickerBtn.title = `Pane layout · ${layoutName()}`; };
  const closePicker = () => { if (pickerOpen) { pickerOpen.remove(); pickerOpen = null; ui.pickerBtn.classList.remove('active'); ui.pickerBtn.setAttribute('aria-expanded', 'false'); } };
  ui.pickerBtn.removeAttribute('disabled');
  ui.pickerBtn.addEventListener('click', () => {
    if (pickerOpen) { closePicker(); return; }
    closeScale();
    const pop = tpl('mk-tpl-layout');
    const current = layoutKey();
    $$('.layout-choice', pop).forEach((b) => {
      const on = b.dataset.layout === current;
      b.classList.toggle('selected', on); b.setAttribute('aria-checked', String(on));
      if (on) { const c = document.createElement('span'); c.className = 'layout-choice-check'; c.setAttribute('aria-hidden', 'true'); c.textContent = '✓'; b.append(c); }
      b.addEventListener('click', () => { setLayout(b.dataset.layout); state.full = null; closePicker(); syncPicker(); render(true); ui.pickerBtn.focus(); });
    });
    ui.picker.append(pop); pickerOpen = pop;
    ui.pickerBtn.classList.add('active'); ui.pickerBtn.setAttribute('aria-expanded', 'true');
  });

  // ---------- dividers: free resize, no snap ----------
  const grab = (e, onMove, onDone) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const bar = e.currentTarget; bar.classList.add('mk-active'); ui.grid.classList.add('adjusting');
    const move = (ev) => { onMove(ev); liveLayout(); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      bar.classList.remove('mk-active'); ui.grid.classList.remove('adjusting'); if (onDone) onDone();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const setFocusWidth = (fw) => { state.focusFrac = clamp(fw, MIN_FOCUS, fr.W - GAP - MIN_SIDE) / (fr.W - GAP); };
  split.addEventListener('pointerdown', (e) => {
    const g0r = ui.grid.getBoundingClientRect();
    grab(e, (ev) => {
      const x = ev.clientX - g0r.left;
      setFocusWidth(state.layout === 'right' ? PAD + fr.W - x - GAP / 2 : x - PAD - GAP / 2);
    });
  });
  split.addEventListener('dblclick', () => { state.focusFrac = 0.58; render(true); });
  split.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = (e.key === 'ArrowRight' ? 1 : -1) * (state.layout === 'right' ? -1 : 1);
    setFocusWidth(fr.main.w + dir * (e.shiftKey ? 80 : 24)); liveLayout();
  });
  // Column dividers live in the map, so they move and scale with it.
  function makeColBar(i) {
    const bar = document.createElement('div'); bar.className = 'mk-colsplit'; bar.title = 'Drag to resize columns · Double-click to even them out';
    bar.addEventListener('pointerdown', (e) => {
      const key = world.key; const n = world.cols.length + 1; const avail = world.W - (n - 1) * GAP;
      const start = fracs(key, n).map((f) => f * avail); const x0 = e.clientX; const z = cam.z;
      grab(e, (ev) => {
        const pair = start[i] + start[i + 1];
        const a = clamp(start[i] + (ev.clientX - x0) / z, MIN_W, pair - MIN_W);
        const w = [...start]; w[i] = a; w[i + 1] = pair - a;
        state.colFracs.set(key, w.map((v) => v / avail));
      });
    });
    bar.addEventListener('dblclick', () => { state.colFracs.delete(world.key); render(true); });
    return bar;
  }
  const placeBars = () => {
    // Columns are set by zoom now (equal widths that always fill the area), so
    // there are no column dividers to drag. The Focus divider still resizes.
    const on = false;
    while (on && colBars.length < world.cols.length) colBars.push(makeColBar(colBars.length));
    colBars.forEach((bar, i) => {
      if (!on || i >= world.cols.length || world.widths[i] * cam.z < 60) { bar.remove(); return; }
      if (bar.parentElement !== mapEl) mapEl.insertBefore(bar, mini);
      const top = Math.max(0, -cam.y * cam.z); const bottom = Math.min(viewH(), (world.H - cam.y) * cam.z);
      bar.style.left = `${(world.cols[i] + GAP / 2 - cam.x) * cam.z - 4}px`; bar.style.top = `${top}px`; bar.style.height = `${Math.max(0, bottom - top)}px`;
    });
  };

  // ---------- drag a title bar to move: the pane follows the pointer ----------
  // Other panes glide out of the way as it passes; drop anywhere. Dropping in
  // the tall slot makes it the focus pane. Esc puts everything back. Near the
  // map's edges the map pans along.
  let drag = null;
  const startDrag = (e, id) => {
    if (e.button !== 0 || e.target.closest('button, .pane-menu-wrap') || state.full || isSyn(id)) return;
    const p = paneOf(id);
    drag = { id, p, x: e.clientX, y: e.clientY, moved: false, order: [...state.order] };
    const move = (ev) => {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 5) return;
        drag.moved = true; anim = null;
        const r = p.getBoundingClientRect(); const g = ui.grid.getBoundingClientRect();
        drag.dx = drag.x - r.left; drag.dy = drag.y - r.top;
        const a = anchorOf(p);
        livePanes.delete(id); unleave(id, p);
        ui.grid.append(p); p._x = p._y = undefined; applyAnchor(p, a); p.classList.add('mk-lifted'); ui.grid.classList.add('adjusting');
        p.style.left = `${r.left - g.left}px`; p.style.top = `${r.top - g.top}px`;
        ui.grid.append(slot);
      }
      const g = ui.grid.getBoundingClientRect();
      p.style.left = `${ev.clientX - g.left - drag.dx}px`; p.style.top = `${ev.clientY - g.top - drag.dy}px`;
      edgePan(ev);
      const at = bestIndex(ev.clientX - g.left, ev.clientY - g.top);
      const open = openIds(); const others = open.filter((x) => x !== id);
      const want = [...others.slice(0, at), id, ...others.slice(at)];
      if (want.join() !== open.join()) {
        state.order = [...want, ...state.order.filter((x) => state.closed.has(x))];
        glide(() => place(p), p);
      }
      showSlot();
    };
    const finish = (cancel) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', esc, true);
      const d = drag; drag = null; if (!d || !d.moved) return;
      if (cancel) state.order = d.order;
      slot.remove(); ui.grid.classList.remove('adjusting');
      glide(() => { p.classList.remove('mk-lifted'); p._x = p._y = undefined; place(); });
      render();
    };
    const up = () => finish(false);
    const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(true); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('keydown', esc, true);
  };
  const edgePan = (ev) => {
    if (!fr.map) return;
    const r = mapEl.getBoundingClientRect(); const e = 44; let dx = 0; let dy = 0;
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
    if (ev.clientY > r.bottom - e) dy = 14; else if (ev.clientY < r.top + e) dy = -14;
    if (ev.clientX > r.right - e && world.W * cam.z > viewW()) dx = 14; else if (ev.clientX < r.left + e && world.W * cam.z > viewW()) dx = -14;
    if (dx || dy) panBy(dx, dy, true);
  };
  // Grid-space rect where `id` would sit in this order, with the camera as it is.
  const targetRect = (order, id) => {
    const f = frameFor(order);
    if (f.mainId === id) return { ...f.main, main: true };
    if (!f.map) return null;
    const w = makeWorld(f.map, f.mapIds); const i = f.mapIds.indexOf(id); if (i < 0) return null;
    const p = posAt(w, i);
    return { x: f.map.x + (p.x - cam.x) * cam.z, y: f.map.y + (p.y - cam.y) * cam.z, w: p.w * cam.z, h: p.h * cam.z, main: false };
  };
  // Pick the insertion point whose slot is closest to the pointer.
  const bestIndex = (px, py) => {
    const others = openIds().filter((x) => x !== drag.id);
    let best = 0; let bestD = Infinity;
    for (let k = 0; k <= others.length; k++) {
      const r = targetRect([...others.slice(0, k), drag.id, ...others.slice(k)], drag.id); if (!r) continue;
      const dx = Math.max(r.x - px, 0, px - (r.x + r.w)); const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
      const d = Math.hypot(dx, dy) * 4 + Math.hypot(px - (r.x + r.w / 2), py - (r.y + r.h / 2)) * 0.001;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  };
  const showSlot = () => {
    const r = targetRect(openIds(), drag.id); if (!r) return;
    box(slot, r);
    slot.classList.toggle('mk-slot-focus', r.main);
  };
  // Keyboard: Alt+←/→ moves the selected pane one place.
  const nudge = (id, dir) => {
    const open = openIds(); const i = open.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= open.length) return;
    [open[i], open[j]] = [open[j], open[i]];
    state.order = [...open, ...state.order.filter((x) => state.closed.has(x))];
    render(true);
    reveal(id);
  };

  // ---------- + New thread and the Add bots menu ----------
  // A new thread takes the first slot: the tall pane in Focus left/right, the
  // first cell in Even grid. In full screen it replaces the full-screen pane.
  const newThread = () => {
    closeAdd();
    state.made += 1;
    const t = { id: `mk-new-${state.made}`, title: state.made === 1 ? 'Group chat' : `Group chat ${state.made}`, members: [], messages: [] };
    state.added.push(t);
    state.order = [t.id, ...state.order];
    if (state.full) state.full = t.id;
    state.selected = t.id;
    render(true);
    reveal(t.id);
    const p = paneOf(t.id); flash(p);
    requestAnimationFrame(() => openAdd(t.id));
  };
  $('.titlebar-new').addEventListener('click', (e) => { e.stopPropagation(); newThread(); });
  $('.titlebar-new').title = 'Mockup: makes a new group chat';
  const wsNew = $$('.ws-row .row-acts button').find((b) => /^New thread/.test(b.getAttribute('aria-label') || ''));
  if (wsNew) wsNew.addEventListener('click', (e) => { e.stopPropagation(); newThread(); }, true);

  // The add menu docks in the shared composer, which is as wide as the canvas,
  // and grows upward over the panes. Nothing reflows; the To line names the thread.
  const shared = $('#mk-shared');
  const ci = $('#mk-shared .composer-input');
  const cbox = $('#mk-shared .composer-box');
  let adding = null;
  // Place the open add menu over the composer's slot. Re-run on window resize so it never keeps a stale width or position.
  const placeDock = () => {
    const spacer = $('.mk-dock-spacer', shared); if (!spacer || !ci.classList.contains('mk-docked')) return;
    // Measure the composer in its normal slot (undocked, spacer hidden), then dock it again. Synchronous, so nothing paints.
    const menuEl = adding && adding.form;
    ci.style.left = ci.style.width = ci.style.bottom = '';
    ci.classList.remove('mk-docked'); cbox.classList.remove('adding'); spacer.style.display = 'none'; if (menuEl) menuEl.style.display = 'none';
    const lockH = shared.style.height; shared.style.height = '';
    const sh = shared.getBoundingClientRect(); const r = ci.getBoundingClientRect();
    shared.style.height = lockH; spacer.style.display = ''; if (menuEl) menuEl.style.display = ''; cbox.classList.add('adding'); ci.classList.add('mk-docked');
    ci.style.left = `${r.left - sh.left}px`; ci.style.width = `${r.width}px`; ci.style.bottom = `${sh.bottom - r.bottom}px`;
    ci.style.setProperty('--mk-qa-max', `${Math.round(Math.max(260, Math.min(560, ui.grid.clientHeight * 0.78)))}px`);
  };
  window.addEventListener('resize', () => { if (adding) placeDock(); });
  const closeAdd = () => {
    if (!adding) return;
    adding.form.remove(); cbox.classList.remove('adding');
    ci.classList.remove('mk-docked'); ci.removeAttribute('style'); shared.style.height = '';
    $$('.mk-dock-spacer', shared).forEach((el) => el.remove());
    $$('[aria-expanded="true"]').forEach((b) => { if (b.matches('.chip-add, .empty-copy .primary, .quick-add-wrap button')) b.setAttribute('aria-expanded', 'false'); });
    adding = null;
  };
  const openAdd = (id) => {
    closeAdd(); closeMenu(); closePicker(); closeScale();
    if (state.selected !== id) select(id);
    const t = T(id); if (!t) return;
    const form = tpl('mk-tpl-quickadd');
    const have = new Set(members(t).map((m) => (m.id || m.name || '').toLowerCase()).concat(members(t).map((m) => (m.name || '').toLowerCase())));
    const picked = [];
    const editors = [];
    const saved = $('.quick-add-saved', form);
    const savedSection = saved.previousElementSibling;
    // Select all / Clear all in the saved agents header
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'quick-add-select-all';
    selectAllBtn.setAttribute('aria-label', 'Select all saved agents');
    savedSection.append(selectAllBtn);
    const another = $('.quick-add-another', form);
    const MAX_NEW = 4;
    const takenNames = () => new Set([...Object.values(BOTS).map((b) => b.name.toLowerCase()), ...members(t).map((m) => m.name.toLowerCase())]);
    const editorName = (ed) => ed.name.value.trim();
    const problem = () => {
      const seen = takenNames();
      for (const ed of editors) {
        const n = editorName(ed);
        if (!n) return 'Give each new agent a name';
        if (!/^[A-Za-z][\w-]{0,23}$/.test(n)) return `“${n}”: start with a letter; letters, digits, - and _ only`;
        if (seen.has(n.toLowerCase())) return `@${n.toLowerCase()} is already taken`;
        seen.add(n.toLowerCase());
      }
      return '';
    };
    const allSavedBids = [];
    const sync = () => {
      $('.quick-add-section .quick-add-count', form).textContent = `${picked.length} picked`;
      const faces = $('.quick-add-faces', form); faces.replaceChildren();
      for (const bid of picked) { const f = tpl('mk-tpl-tile').querySelector('.identicon'); f.className = 'identicon identicon-sm'; paintIdenticon(f, BOTS[bid].seed, BOTS[bid].color); faces.append(f); }
      for (const ed of editors) { const f = document.createElement('span'); f.className = 'quick-add-face'; f.textContent = (editorName(ed)[0] || '?').toUpperCase(); faces.append(f); }
      const say = $('.quick-add-say', form);
      say.childNodes.forEach((n) => { if (n.nodeType === 3) n.remove(); });
      const names = [...picked.map((bid) => BOTS[bid].name), ...editors.map((ed) => editorName(ed) || 'unnamed')];
      const err = problem();
      say.prepend(err || (names.length ? (names.length === 1 ? `1 agent will join: ${names[0]}` : `${names.length} agents will join: ${names.join(', ')}`) : 'Pick at least one agent'));
      say.classList.toggle('mk-say-error', !!err);
      const go = $('.quick-add-foot button.primary', form);
      go.disabled = !names.length || !!err; go.textContent = !names.length ? 'Pick an agent' : names.length === 1 ? 'Add 1 agent' : `Add ${names.length} agents`;
      another.disabled = editors.length >= MAX_NEW;
      another.title = editors.length >= MAX_NEW ? 'Up to 4 new agents at a time' : 'Set up a new agent';
      $$('.quick-add-section', form).at(-1).querySelector('.quick-add-count').textContent = editors.length ? `${editors.length} of ${MAX_NEW}` : `Up to ${MAX_NEW}`;
      const total = allSavedBids.length; const cur = picked.length;
      if (!total) selectAllBtn.style.display = 'none';
      else {
        selectAllBtn.style.display = '';
        if (cur === 0) { selectAllBtn.textContent = 'Select all'; selectAllBtn.dataset.state = 'none'; }
        else if (cur === total) { selectAllBtn.textContent = 'Clear all'; selectAllBtn.dataset.state = 'all'; }
        else { selectAllBtn.textContent = `Select all · ${cur}/${total}`; selectAllBtn.dataset.state = 'some'; }
      }
    };
    const applyPickedState = () => {
      $$('.quick-add-tile', saved).forEach((tile) => { tile.setAttribute('aria-checked', String(picked.includes(tile.dataset.bid))); });
    };
    const selectAll = () => {
      if (picked.length === allSavedBids.length) picked.length = 0;
      else { picked.length = 0; picked.push(...allSavedBids); }
      applyPickedState(); sync();
    };
    // One editor per new agent, cloned from Deck's real form.
    const DEFAULT_NAME = { 'Claude Code': 'Claude', Codex: 'Codex', Ollama: 'Ollama' };
    const TOOL_ID = { 'Claude Code': 'claude_code', Codex: 'codex', Ollama: 'ollama' };
    const addEditor = () => {
      if (editors.length >= MAX_NEW) return;
      const el = tpl('mk-tpl-qaeditor');
      const name = $('input[name="quick-name"]', el);
      const hint = $('.quick-add-grid .hint', el);
      const model = $('select[name="quick-model"]', el);
      const claudeModels = model.innerHTML;
      const ed = { el, name, tool: 'Claude Code', touched: false };
      // Unique starting name so two new Claudes don't collide.
      const freshName = (base) => { const taken = takenNames(); editors.forEach((o) => o !== ed && taken.add(editorName(o).toLowerCase())); let n = base; let i = 2; while (taken.has(n.toLowerCase())) n = `${base}${i++}`; return n; };
      const setHint = () => { hint.textContent = editorName(ed) ? `Mention as @${editorName(ed).toLowerCase()}` : 'Needs a name'; };
      $$('.qa-tool[role="radio"]', el).forEach((btn) => btn.addEventListener('click', () => {
        $$('.qa-tool[role="radio"]', el).forEach((o) => { o.classList.toggle('on', o === btn); o.setAttribute('aria-checked', String(o === btn)); });
        ed.tool = btn.title.replace(/ \(.*\)$/, '');
        model.innerHTML = ed.tool === 'Claude Code' ? claudeModels : '<option value="">Default</option>';
        if (!ed.touched) { name.value = freshName(DEFAULT_NAME[ed.tool] || 'Agent'); }
        setHint(); sync();
      }));
      $('.qa-more', el).addEventListener('click', () => toast('Mockup: More… lists every provider in Deck; not wired here'));
      name.addEventListener('input', () => { ed.touched = true; setHint(); sync(); });
      const persona = $('.persona-draft textarea', el); const write = $('.persona-draft-go', el);
      persona.id = `mk-persona-${Math.random().toString(36).slice(2, 8)}`; $('.persona-draft-title', el).htmlFor = persona.id;
      persona.addEventListener('input', () => { write.disabled = !persona.value.trim(); });
      write.addEventListener('click', () => toast('Mockup: Write it would draft a full persona prompt here'));
      $('.quick-add-editor-x', el).addEventListener('click', () => { editors.splice(editors.indexOf(ed), 1); el.remove(); sync(); another.focus(); });
      name.value = freshName('Claude'); setHint();
      another.before(el); editors.push(ed); sync();
      el.scrollIntoView({ block: 'nearest' }); name.focus(); name.select();
    };
    for (const [bid, b] of Object.entries(BOTS)) {
      if (have.has(bid) || have.has(b.name.toLowerCase())) continue;
      allSavedBids.push(bid);
      const tile = tpl('mk-tpl-tile');
      tile.dataset.bid = bid;
      tile.style.setProperty('--ring', b.color);
      paintIdenticon($('.identicon', tile), b.seed, b.color);
      $('.quick-add-tile-name', tile).textContent = b.name;
      tile.title = `${b.name} · ${agentMeta(b)}`;
      tile.addEventListener('click', () => {
        const on = tile.getAttribute('aria-checked') !== 'true';
        tile.setAttribute('aria-checked', String(on));
        if (on) picked.push(bid); else picked.splice(picked.indexOf(bid), 1);
        sync();
      });
      saved.append(tile);
    }
    // Like Deck: with no saved agents left to pick, the form opens on a new-agent editor.
    if (!saved.children.length) { savedSection.remove(); saved.remove(); addEditor(); }
    else selectAllBtn.addEventListener('click', selectAll);
    $('.quick-add-close', form).addEventListener('click', closeAdd);
    another.addEventListener('click', addEditor);
    // Keyboard: Cmd/Ctrl+A selects all while the add menu is open
    form.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !e.target.matches('input, textarea')) {
        e.preventDefault(); if (allSavedBids.length) selectAll();
      }
    });
    $('.quick-add-foot .ghost', form).addEventListener('click', () => { if (!editors.length) addEditor(); toast('Mockup: More options opens Deck’s full new-agent form; the quick form is shown instead'); });
    form.addEventListener('submit', (e) => {
      e.preventDefault(); if ((!picked.length && !editors.length) || problem()) return;
      const list = state.extra.get(t.id) || [];
      for (const bid of picked) list.push({ id: bid, name: BOTS[bid].name });
      // New agents are saved like Deck saves them, so they show up as saved agents next time.
      const PALETTE = ['#f59e0b', '#22d3ee', '#f472b6', '#84cc16', '#a78bfa', '#fb7185'];
      for (const ed of editors) {
        const k = state.newAgents.length;
        const nid = `mk-agent-${k + 1}`;
        BOTS[nid] = { name: editorName(ed), seed: (window.MK_SPARE_SEEDS || [])[k % 12] || '', color: PALETTE[k % PALETTE.length], tool: TOOL_ID[ed.tool] || 'claude_code', model: $('select[name="quick-model"]', ed.el).value, effort: $('select[name="quick-effort"]', ed.el).value, persona: $('.persona-draft textarea', ed.el).value.trim(), access: $('select[name="quick-access"]', ed.el).value || 'read', made: true };
        state.newAgents.push(nid);
        list.push({ id: nid, name: BOTS[nid].name });
      }
      state.extra.set(t.id, list);
      const n = picked.length + editors.length; closeAdd();
      fillTranscript(paneOf(t.id), t);
      renderComposer(); renderDetails(); requestAnimationFrame(fitAll); schedule();
      toast(`${n === 1 ? '1 agent' : `${n} agents`} joined “${t.title}” in this page only.`);
      ui.input.focus();
    });
    // Lock the composer's footprint, then let the box grow upward over the panes.
    const sh = shared.getBoundingClientRect(); const r = ci.getBoundingClientRect();
    shared.style.height = `${sh.height}px`;
    const spacer = document.createElement('div'); spacer.className = 'mk-dock-spacer'; spacer.style.height = `${r.height}px`; ci.before(spacer);
    ci.classList.add('mk-docked');
    placeDock();
    cbox.classList.add('adding'); cbox.append(form);
    adding = { id, form };
    sync();
    $$('.chip-add, .quick-add-wrap.details > button').forEach((b) => b.setAttribute('aria-expanded', 'true'));
    const p = panes.get(id); if (p) { const b = $('.empty-copy .primary', p); if (b) b.setAttribute('aria-expanded', 'true'); }
    ($('.quick-add-tile', form) || $('.quick-add-close', form)).focus();
  };
  $$('#mk-shared .quick-add-wrap button, #details-bots-body .quick-add-wrap button').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); if (adding) closeAdd(); else openAdd(state.selected); }));
  document.addEventListener('pointerdown', (e) => { if (adding && !adding.form.contains(e.target) && !e.target.closest('.quick-add-wrap, .empty-copy .primary, .mk-tile-add, .titlebar-new, .ws-row')) closeAdd(); }, true);

  // ---------- keys, reset, resize ----------
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.multiPicker) { closeAtPicker(); return; }
      if (state.multiAgentMenu) { closeAgentMenu(); return; }
      // Priority: menus / pickers / add form / full-screen first (per Jigga review), then multi
      if (scaleMenu) { closeScale(); scaleBtn.focus(); return; }
      if (adding) { closeAdd(); return; }
      if (menu) { closeMenu(); return; }
      if (pickerOpen) { closePicker(); return; }
      if (state.full) { state.full = null; render(); return; }
      if (hasMulti()) { const kept = state.multiDraft.trim(); clearMulti(); renderComposer(); renderSidebar(); toast(kept ? 'Selection cleared. Your message is kept; ⌘-click panes to get it back.' : 'Selection cleared'); return; }
    }
    if (e.key === 'Enter' && e.altKey) { e.preventDefault(); toggleFull(state.selected); }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !state.full && !e.target.closest('textarea, input, [contenteditable]')) { e.preventDefault(); nudge(state.selected, e.key === 'ArrowRight' ? 1 : -1); }
  });
  ui.reset.addEventListener('click', () => {
    closeAdd(); closeScale(); closeAgentMenu(); closeAtPicker(); for (const id of state.newAgents) delete BOTS[id];
    anim = null; state = fresh(); for (const p of panes.values()) p.remove(); panes.clear(); livePanes.clear();
    for (const [id, p] of leaving) unleave(id, p); synCache.clear(); th = null; hatchPat = null;
    closeMenu(); closePicker(); syncPicker(); syncScaleBtn(); render(); toast('Mockup reset');
  });
  let lastSize = '';
  new ResizeObserver(() => { const s = ui.grid.clientWidth + 'x' + ui.grid.clientHeight; if (s !== lastSize) { lastSize = s; render(); } }).observe(ui.grid);
  // Mockup test hook: read-only view of the camera and what is drawn.
  window.mkMap = { indexOf: (id) => indexOf(id), rectOf: (i) => world && i < world.n ? toScr(posAt(world, i)) : null, cam: () => ({ ...cam }), world: () => world && { kind: world.kind, n: world.n, W: world.W, H: world.H, C: world.C, rows: world.rows, rowH: world.rowH, flatZoom: state.flatZoom, nReal: world.nReal, rv: world.rv, li: world.li, d: world.d, zoomBy: world.zoomBy || null, band: world.band || null, cv: world.cv || null, colW: world.colW || null }, stats: () => lastStats && { ...lastStats }, where: () => whereNow().long, live: () => [...livePanes.keys()], hist: () => state.hist.length, field: () => [...fields].filter((c) => c.isConnected).map((c) => ({ n: c._f.n, K: c._f.K, z: c._f.fc.z })), _setZoom: (z) => setFlatZoom(z, viewW() / 2, viewH() / 2), levels: () => world && world.kind === 'flat' ? world.levels.map((L, i) => ({ i, c: L.c, r: L.r, shown: L.shown, w: Math.round(L.w), h: Math.round(L.h), cur: i === world.li, def: i === world.d })) : [] };
  window._testMulti = { toggle: (id)=>toggleMulti(id), state: ()=>({selected:state.selected, multi:[... (state.multiSelected||[])], draft:state.multiDraft, overrides:[...state.multiOverrides],sent:[...state.sent]}), parse: (txt)=>parseThreadSlices(txt), plan: ()=>computeMultiPlan() };
  syncPicker(); syncScaleBtn();
  render();
})();
