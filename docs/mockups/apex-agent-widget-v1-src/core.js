(function(){
  const listeners = {};
  const saved = (() => { try { return JSON.parse(localStorage.getItem('aa-pos')||'null'); } catch { return null; } })();
  const AA = window.AA = {
    parts: {},
    state: {
      page:'threads', status:'new', needs:0, open:false, size:'compact', tab:'chat', hidden:false,
      pos: saved || {edge:'right', y: 420}, project:'mobile',
      projects:[
        {id:'mobile', name:'Mobile launch', folder:'~/code/mobile-launch', machine:'This Mac', status:'watching', needs:0},
        {id:'deck', name:'Apex Deck', folder:'/srv/apex-deck', machine:'Hetzner', status:'watching', needs:0}],
      setup:'none', sources:[], messages:[], context:{label:'Threads › Release thread'}, switcher:false,
      look:{shape:'orb', color:'mint', eyes:true, glasses:false},
      quiet:{on:false, from:'22:00', to:'08:00'}, routes:{routine:'panel', decisions:'bubble+phone'}
    },
    on(e, fn){ (listeners[e] ||= []).push(fn); },
    emit(e, p){ (listeners[e]||[]).forEach(fn => { try { fn(p, AA.state); } catch(err){ console.error('[AA '+e+']', err); } }); },
    set(patch){ Object.assign(AA.state, patch); if (patch.pos) try { localStorage.setItem('aa-pos', JSON.stringify(patch.pos)); } catch {} AA.emit('change', patch); },
    part(name, obj){ AA.parts[name] = obj; },
    addMessage(m){ AA.state.messages = [...AA.state.messages, {time: m.time || 'now', id: m.id || ('m'+Math.random().toString(36).slice(2,8)), ...m}]; AA.emit('change', {messages:true}); },
    bubble(b){ AA.emit('bubble', b); },
    esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
    layer(){ return document.getElementById('aa-layer').getBoundingClientRect(); },
    AVATAR: 56,
    panelRect(){
      const L = AA.layer(), s = AA.state, w = s.size === 'tall' ? 460 : 380;
      const h = s.size === 'tall' ? L.height - 24 : Math.min(560, L.height - 24);
      const left = s.pos.edge === 'right' ? L.width - AA.AVATAR - 24 - w : AA.AVATAR + 24;
      let top = s.size === 'tall' ? 12 : s.pos.y + AA.AVATAR/2 - h/2;
      top = Math.max(12, Math.min(top, L.height - h - 12));
      return {left, top, width:w, height:h};
    }
  };
  window.addEventListener('DOMContentLoaded', () => {
    for (const [n, p] of Object.entries(AA.parts)) { try { p.mount && p.mount(); } catch(err){ console.error('[mount '+n+']', err); } }
    AA.emit('change', {});
    AA.emit('ready');
  });
})();
