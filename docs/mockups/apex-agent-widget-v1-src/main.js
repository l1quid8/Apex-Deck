(function(){
  const S = AA.state;
  function page(p){ document.querySelectorAll('.sh-page').forEach(e=>e.classList.toggle('sh-show', e.dataset.page===p));
    document.querySelectorAll('#sh-tabs button').forEach(b=>b.classList.toggle('sh-on', b.dataset.page===p));
    AA.set({page:p, context: p==='threads'?{label:'Threads › Release thread'}: p==='code'?{label:'Code › test-report.md'}:null}); }
  AA.page = page;
  document.addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b && !b.closest('.sh-page')) page(b.dataset.page); });
  window.STEPS = [];   // filled by lead later; helpers: ignore
  let cur = 0;
  window.go = function(n){ cur = Math.max(0, Math.min(n, STEPS.length-1)); const st = STEPS[cur]; if (!st) return;
    st.apply(); document.getElementById('st-count').textContent = (cur+1)+' / '+STEPS.length;
    document.getElementById('st-title').textContent = st.title; document.getElementById('st-note').textContent = st.note; };
  AA.on('ready', () => {
    document.getElementById('st-prev').onclick = () => go(cur-1);
    document.getElementById('st-next').onclick = () => go(cur+1);
    document.getElementById('st-motion').onchange = e => document.documentElement.classList.toggle('aa-reduce-motion', e.target.checked);
    if (STEPS.length) go(0);
  });
})();
