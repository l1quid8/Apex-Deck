(function(){
  const blocker = () => ({id:'blk1', from:'agent', kind:'blocker', status:'open', time:'9:41',
    text:'SSO tests are failing, and the launch plan needs SSO before Nov 1. Defer SSO, or move the date?',
    observed:'3 of 12 SSO login tests fail in last night\'s report.',
    inference:'At the current fix rate SSO won\'t be ready for Nov 1.',
    evidence:[{label:'test-report.md', line:14, quote:'SSO login: 3 of 12 failing'},
              {label:'docs/launch-plan.md', line:22, quote:'SSO must ship before release'}]});
  const watched = [
    {id:'s1',kind:'file',label:'docs/launch-plan.md',why:'mentions Nov 1 eight times',on:true},
    {id:'s2',kind:'file',label:'test-report.md',why:'nightly results',on:true},
    {id:'s3',kind:'thread',label:'Release thread',why:'you used it this week',on:true},
    {id:'s4',kind:'thread',label:'SSO fixes',why:'you used it this week',on:true},
    {id:'s5',kind:'git',label:'main · last 7 days',why:'local Git',on:true}];
  const hello = {id:'h1', from:'agent', kind:'text', time:'9:02', text:"On it. I'll check when something changes and stay quiet otherwise. Next look: in about 20 min."};
  const checks = [{id:'c1',from:'agent',kind:'check',time:'9:14',text:'Checked 6 sources · nothing new · 9:14'},
                  {id:'c2',from:'agent',kind:'check',time:'9:38',text:'test-report.md changed · checking'}];
  const intro = on => { const el = document.getElementById('in-card'); if (el) el.style.display = on ? '' : 'none'; };
  function base(p){ const bb = AA.parts.bb; bb && bb.clear && bb.clear(); intro(false);
    AA.set(Object.assign({open:false, size:'compact', tab:'chat', hidden:false, switcher:false, status:'watching', needs:0,
      setup:'done', sources:watched, messages:[hello], pos:{edge:'right', y:430}, quiet:{on:false,from:'22:00',to:'08:00'},
      look:{shape:'orb',color:'mint',eyes:true,glasses:false}}, p||{})); }
  const later = (ms, fn) => setTimeout(fn, ms);
  window.STEPS = [
    {title:'Meet Apex', note:'A small glowing avatar floats over every page. No setup form — it just says hi.',
      apply(){ AA.page('threads'); base({status:'new', setup:'none', sources:[], messages:[]}); intro(true); }},
    {title:'First click: setup happens in chat', note:'It already knows the project and suggests what to watch. Tap × to drop a source; one button to start.',
      apply(){ AA.page('threads'); base({status:'new', setup:'proposing', sources:[], messages:[], open:true, size:'tall'}); }},
    {title:'Watching (calm glow)', note:'Close the chat and keep working. The slow breathing glow means it is watching. Drag it anywhere; it snaps to an edge.',
      apply(){ AA.page('threads'); base({messages:[hello, checks[0]]}); }},
    {title:'Follows you to every page', note:'Switch to Code (or any tab): same Apex, same place, still watching Mobile launch. It never switches its assignment because you changed pages.',
      apply(){ AA.page('code'); base({messages:[hello, checks[0]]}); }},
    {title:'Checking (swirl)', note:'test-report.md changed, so Apex looks sooner than planned. The swirl means it is reading.',
      apply(){ AA.page('code'); base({status:'checking', messages:[hello, checks[0], checks[1]]}); }},
    {title:'A blocker: amber + speech bubble', note:'Something needs you, so it speaks up next to the avatar with the evidence. You can answer right in the bubble.',
      apply(){ AA.page('code'); base({status:'needs', needs:1, messages:[hello, checks[0], checks[1], blocker()]});
        later(250, () => AA.bubble({id:'blk1', tone:'decision', text:'SSO tests are failing and the launch plan needs SSO before Nov 1. Defer SSO or move the date?', evidence:['test-report.md:14','launch-plan.md:22']})); }},
    {title:'Open the chat: evidence, not guesses', note:'The blocker shows what it saw (with file + line) separately from what it thinks. Reading it does not clear it.',
      apply(){ AA.page('code'); base({status:'needs', needs:1, open:true, messages:[hello, checks[0], checks[1], blocker()]}); }},
    {title:'Redirect without restarting', note:'"Defer SSO, keep November 1, and draft the revised plan." Same assignment continues; the decision is remembered.',
      apply(){ AA.page('code'); const b = blocker(); b.status = 'resolved';
        base({status:'watching', open:true, size:'tall', messages:[hello, checks[0], b,
          {id:'u1',from:'me',kind:'text',time:'9:44',text:'Defer SSO, keep November 1, and draft the revised plan.'},
          {id:'n1',from:'agent',kind:'note',time:'9:44',text:"I'll remember: SSO is deferred past Nov 1. I won't raise the SSO tests as a launch blocker again unless that changes."},
          {id:'d1',from:'agent',kind:'draft',time:'9:45',title:'Launch plan — revised (draft)',text:'Nov 1 · Mobile launch (unchanged)\n• SSO moves to 1.1 (target Nov 15)\n• Email + password login ships at launch\n• Release notes: mention SSO "coming soon"\n\nNothing is changed in the repo until you say so.'},
          {id:'t2',from:'agent',kind:'text',time:'9:45',text:'Still watching the rest: store copy is due Friday, and 2 UI tests are new since yesterday.'}]}); }},
    {title:'Drag anything onto Apex', note:'Drag a file or chat from the sidebar onto the avatar to add it to what Apex watches — try CHANGELOG.md.',
      apply(){ AA.page('threads'); base({}); later(250, () => AA.bubble({id:'drop', tone:'routine', text:"Drag a file or chat onto me and I'll watch it too."})); }},
    {title:'Activity lives inside', note:'What it is doing now, what needs you, recent checks, anything scheduled, and what it watches. Pause and Check now are here.',
      apply(){ AA.page('threads'); base({open:true, tab:'activity'}); }},
    {title:'Configuration lives inside too', note:'Make it yours, where updates go, quiet hours, what it remembers, and Hide (keeps working) vs Pause (stops).',
      apply(){ AA.page('threads'); base({open:true, tab:'settings', size:'tall'}); }},
    {title:'One Apex, many projects', note:'The project chip switches between watched projects. Still just one avatar on screen.',
      apply(){ AA.page('threads'); const ps = AA.state.projects.map(p => p.id === 'deck' ? {...p, status:'needs', needs:2} : p);
        base({open:true, switcher:true, projects:ps, needs:2, status:'needs'}); }},
    {title:'Hide for now', note:'The avatar tucks into a thin glowing tab on the edge. Apex keeps working; amber if something needs you.',
      apply(){ AA.page('threads'); base({hidden:true}); }},
    {title:'Paused / offline', note:'Paused = dimmed (you stopped it). Offline = grey dashed ring (the machine that runs it is asleep).',
      apply(){ AA.page('threads'); base({status:'paused', pos:{edge:'left', y:380}}); }},
    {title:'Quiet hours + left edge', note:'Dropped on the left edge. During quiet hours routine updates stay silent; decisions wait for morning.',
      apply(){ AA.page('library'); base({pos:{edge:'left', y:260}, quiet:{on:true, from:'22:00', to:'08:00'}, status:'needs', needs:1});
        later(250, () => AA.bubble({id:'q', tone:'decision', text:'Store copy is due tomorrow and has no owner yet.'})); }}
  ];
})();
// A canned responder so typing in the chat or a bubble feels alive in the mockup.
(function(){
  AA.on('user-message', t => {
    const s = String(t).toLowerCase();
    let reply = "Got it — I've added that to the assignment and kept everything else as is.";
    if (s.includes('defer sso')) reply = "Done. SSO is deferred past Nov 1 and I'll remember that. Drafting the revised plan now.";
    else if (s.includes('what needs me')) reply = AA.state.needs ? 'One thing: the SSO blocker above. Everything else is on track.' : 'Nothing right now. Store copy is due Friday; I\'ll nudge you Thursday if it isn\'t in.';
    else if (s.includes('changed')) reply = 'Today: test-report.md (3 SSO failures), 4 commits on main, and the Release thread agreed Friday for store copy.';
    else if (s.includes('check now')) { AA.set({status:'checking'}); setTimeout(() => { AA.set({status: AA.state.needs ? 'needs' : 'watching'}); AA.addMessage({from:'agent',kind:'check',text:'Checked 6 sources · nothing new · now'}); }, 2500); return; }
    setTimeout(() => AA.addMessage({from:'agent', kind:'text', text: reply}), 900);
  });
})();
