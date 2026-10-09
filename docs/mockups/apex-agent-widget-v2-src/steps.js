(function(){
  const blocker = () => ({id:'blk1', from:'agent', kind:'blocker', status:'open', time:'9:41',
    text:'SSO tests are failing, and the launch plan needs SSO before Nov 1. Defer SSO, or move the date?',
    observed:'3 of 12 SSO login tests fail in last night\'s report.',
    inference:'At the current fix rate SSO won\'t be ready for Nov 1.',
    evidence:[{label:'test-report.md', line:14, quote:'SSO login: 3 of 12 failing'},
              {label:'docs/launch-plan.md', line:22, quote:'SSO must ship before release'}]});
  const deckBlocker = () => ({id:'dblk1', from:'agent', kind:'blocker', status:'open', time:'8:55',
    text:'The ApexAgent branch is 14 commits behind main, and the plan says it must be rebased before Null\'s final review.',
    observed:'feat/apex-agent is 14 commits behind main; the glass theme commits touch src/App.tsx.',
    inference:'The App.tsx overlap will need a hand merge before review.',
    evidence:[{label:'Git · feat/apex-agent', line:0, quote:'14 behind, 9 ahead of main'},
              {label:'docs/plans/agents-assistant-scheduling.md', line:211, quote:'rebase on main before final review'}]});
  const storeCopy = () => ({id:'q1', from:'agent', kind:'blocker', status:'open', time:'22:14',
    text:'Store copy is due tomorrow and has no owner yet.',
    observed:'docs/launch-plan.md lists "App Store copy · due Oct 10 · owner: —".',
    inference:'Nobody is on it, so it may miss the deadline.',
    evidence:[{label:'docs/launch-plan.md', line:31, quote:'App Store copy · due Oct 10 · owner: —'}]});
  const watched = [
    {id:'s1',kind:'file',ref:'docs/launch-plan.md',label:'docs/launch-plan.md',why:'mentions Nov 1 eight times',on:true},
    {id:'s2',kind:'file',ref:'test-report.md',label:'test-report.md',why:'nightly results',on:true},
    {id:'s3',kind:'thread',ref:'thr-release',label:'Release thread',why:'you used it this week',on:true},
    {id:'s4',kind:'thread',ref:'thr-sso',label:'SSO fixes',why:'you used it this week',on:true},
    {id:'s5',kind:'git',ref:'git:main',label:'main · last 7 days',why:'local Git',on:true}];
  const deckWatched = [
    {id:'d1',kind:'file',ref:'docs/plans/agents-assistant-scheduling.md',label:'docs/plans/agents-assistant-scheduling.md',why:'the plan you\'re building',on:true},
    {id:'d2',kind:'thread',ref:'thr-deploy',label:'Deploy checklist',why:'you used it today',on:true},
    {id:'d3',kind:'git',ref:'git:main',label:'main · last 7 days',why:'Git on Hetzner',on:true}];
  const hello = {id:'h1', from:'agent', kind:'text', time:'9:02', text:"On it. I'll check when something changes and stay quiet otherwise. Next look: in about 20 min."};
  const deckHello = {id:'dh1', from:'agent', kind:'text', time:'8:30', text:"Watching Apex Deck on Hetzner. It keeps running while your Mac sleeps."};
  const checks = [{id:'c1',from:'agent',kind:'check',time:'9:14',text:'Checked 6 sources · nothing new · 9:14'},
                  {id:'c2',from:'agent',kind:'check',time:'9:38',text:'test-report.md changed · checking'}];
  const intro = on => { const el = document.getElementById('in-card'); if (el) el.style.display = on ? '' : 'none'; };
  const MOB = (p) => Object.assign({status:'watching', needs:0, setup:'done', sources:watched, messages:[hello]}, p||{});
  const DECK = (p) => Object.assign({status:'watching', needs:0, setup:'done', sources:deckWatched, messages:[deckHello]}, p||{});
  // ui = non-project fields; mob/deck = each project's own data
  function base(ui, mob, deck){ const bb = AA.parts.bb; bb && bb.clear && bb.clear(); intro(false);
    AA.set(Object.assign({open:false, size:'compact', tab:'chat', hidden:false, switcher:false, project:'mobile',
      pos:{edge:'right', y:430}, quiet:{on:false,from:'22:00',to:'08:00'},
      projects:[{id:'mobile', name:'Mobile launch', folder:'~/code/mobile-launch', machine:'This Mac'},
                {id:'deck', name:'Apex Deck', folder:'/srv/apex-deck', machine:'Hetzner'}],
      look:{shape:'orb',color:'mint',eyes:true,glasses:false}}, ui||{}));
    AA.loadProjects({mobile: MOB(mob), deck: DECK(deck)}); }
  const later = (ms, fn) => setTimeout(fn, ms);
  const drop = (label) => { const el = [...document.querySelectorAll('[data-aa-drag]')].find(e => e.textContent.includes(label));
    return JSON.parse(el.dataset.aaDrag); };
  window.STEPS = [
    {title:'Meet Apex', note:'A small glowing avatar floats over every page. No setup form — it just says hi.',
      apply(){ AA.page('threads'); base({}, {status:'new', setup:'none', sources:[], messages:[]}); intro(true); }},
    {title:'First click: setup happens in chat', note:'It already knows the project and suggests what to watch. Tap × to drop a source; one button to start.',
      apply(){ AA.page('threads'); base({open:true, size:'tall'}, {status:'new', setup:'proposing', sources:[], messages:[]}); }},
    {title:'Watching (calm glow)', note:'Close the chat and keep working. The slow breathing glow means it is watching. Drag it anywhere; it snaps to an edge. The glow stays inside the window.',
      apply(){ AA.page('threads'); base({}, {messages:[hello, checks[0]]}); }},
    {title:'Keyboard works too', note:'Tab to the avatar: Enter or Space opens it, arrow keys move it, Esc closes and puts you back on the avatar. ⌘K opens it from anywhere.',
      apply(){ AA.page('threads'); base({}, {messages:[hello, checks[0]]}); later(150, () => { const b = document.querySelector('.av-hit'); b && b.focus(); }); }},
    {title:'Follows you to every page', note:'Switch to Code (or any tab): same Apex, same place, still watching Mobile launch. It never switches its assignment because you changed pages.',
      apply(){ AA.page('code'); base({}, {messages:[hello, checks[0]]}); }},
    {title:'Checking (swirl)', note:'test-report.md changed, so Apex looks sooner than planned. The swirl means it is reading.',
      apply(){ AA.page('code'); base({}, {status:'checking', messages:[hello, checks[0], checks[1]]}); }},
    {title:'A blocker: amber + speech bubble', note:'Something needs you, so it speaks up next to the avatar with the evidence. You can answer right in the bubble.',
      apply(){ AA.page('code'); base({}, {status:'needs', needs:1, messages:[hello, checks[0], checks[1], blocker()]});
        later(250, () => AA.bubble({id:'blk1', tone:'decision', finding:'blk1', project:'mobile', text:'SSO tests are failing and the launch plan needs SSO before Nov 1. Defer SSO or move the date?', evidence:['test-report.md:14','launch-plan.md:22']})); }},
    {title:'Open the chat: evidence, not guesses', note:'The blocker shows what it saw (with file + line) separately from what it thinks. Reading it does not clear it.',
      apply(){ AA.page('code'); base({open:true}, {status:'needs', needs:1, messages:[hello, checks[0], checks[1], blocker()]}); }},
    {title:'Redirect without restarting', note:'"Defer SSO, keep November 1, and draft the revised plan." Same assignment continues; the decision is remembered.',
      apply(){ AA.page('code'); const b = blocker(); b.status = 'resolved';
        base({open:true, size:'tall'}, {messages:[hello, checks[0], b,
          {id:'u1',from:'me',kind:'text',time:'9:44',text:'Defer SSO, keep November 1, and draft the revised plan.'},
          {id:'n1',from:'agent',kind:'note',time:'9:44',text:"I'll remember: SSO is deferred past Nov 1. I won't raise the SSO tests as a launch blocker again unless that changes."},
          {id:'d1',from:'agent',kind:'draft',time:'9:45',title:'Launch plan — revised (draft)',text:'Nov 1 · Mobile launch (unchanged)\n• SSO moves to 1.1 (target Nov 15)\n• Email + password login ships at launch\n• Release notes: mention SSO "coming soon"\n\nNothing is changed in the repo until you say so.'},
          {id:'t2',from:'agent',kind:'text',time:'9:45',text:'Still watching the rest: store copy is due Friday, and 2 UI tests are new since yesterday.'}]}); }},
    {title:'Drag a file onto Apex: Adding… then Added', note:'Dropping CHANGELOG.md shows "Adding…" while it is saved. "Added" only appears once the save worked. Try dragging it from the sidebar yourself.',
      apply(){ AA.page('threads'); base({}); later(250, () => AA.addSource(drop('CHANGELOG.md'))); }},
    {title:'Same file twice: no duplicate', note:'Drop CHANGELOG.md again and Apex says it is already watching it. The list stays the same.',
      apply(){ AA.page('threads'); base({}, {sources:[...watched, {id:'s6',kind:'file',ref:'CHANGELOG.md',label:'CHANGELOG.md',why:'you dropped it here',on:true}]});
        later(250, () => AA.addSource(drop('CHANGELOG.md'))); }},
    {title:'A drop that can\'t be added', note:'A file outside the project folder (or a chat from another project) is refused with the reason. Nothing is added.',
      apply(){ AA.page('threads'); base({}); later(250, () => AA.addSource(drop('brand-notes.md'))); }},
    {title:'Activity lives inside', note:'What it is doing now, what needs you, recent checks, anything scheduled, and what it watches. Pause and Check now are here.',
      apply(){ AA.page('threads'); base({open:true, tab:'activity'}, {sources:[...watched, {id:'s6',kind:'file',ref:'CHANGELOG.md',label:'CHANGELOG.md',why:'you dropped it here',on:true}]}); }},
    {title:'Configuration lives inside too', note:'Make it yours, where updates go, quiet hours, what it remembers, and Hide (keeps working) vs Pause (stops).',
      apply(){ AA.page('threads'); base({open:true, tab:'settings', size:'tall'}); }},
    {title:'One Apex, many projects', note:'The avatar counts what needs you across every project (here 2). The switcher shows each project\'s own state.',
      apply(){ AA.page('threads'); base({open:true, switcher:true}, {status:'needs', needs:1, messages:[hello, checks[0], blocker()]}, {status:'needs', needs:1, messages:[deckHello, deckBlocker()]}); }},
    {title:'Each project keeps its own chat', note:'Switched to Apex Deck: its own messages, sources and blocker. Mobile launch\'s chat is untouched and still waiting for you.',
      apply(){ AA.page('threads'); base({open:true}, {status:'needs', needs:1, messages:[hello, checks[0], blocker()]}, {status:'needs', needs:1, messages:[deckHello, deckBlocker()]}); AA.switchProject('deck'); }},
    {title:'Over a docked browser', note:'The browser page is drawn above the window, so Apex sits just left of it and opens to the left. The page stays live and clickable. If anything of Apex\'s ever did overlap it, the page would show a picture until that closes, like Deck\'s menus do today.',
      apply(){ AA.page('browser'); base({open:true}, {messages:[hello, checks[0]]}); }},
    {title:'Hide for now', note:'The avatar tucks into a thin glowing tab on the edge. Apex keeps working; amber if something needs you.',
      apply(){ AA.page('threads'); base({hidden:true}); }},
    {title:'Paused / offline', note:'Paused = dimmed (you stopped it). Offline = grey dashed ring (the machine that runs it is asleep).',
      apply(){ AA.page('threads'); base({pos:{edge:'left', y:380}}, {status:'paused'}); }},
    {title:'Quiet hours + left edge', note:'Dropped on the left edge. During quiet hours routine updates stay silent; decisions wait for morning.',
      apply(){ AA.page('library'); base({pos:{edge:'left', y:260}, quiet:{on:true, from:'22:00', to:'08:00'}}, {status:'needs', needs:1, messages:[hello, storeCopy()]});
        later(250, () => AA.bubble({id:'q', tone:'decision', finding:'q1', project:'mobile', text:'Store copy is due tomorrow and has no owner yet.'})); }}
  ];
})();
