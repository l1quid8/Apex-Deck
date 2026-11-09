import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PaneMap } from '/src/PaneMap.tsx';
import { place, stepZoom, validArrangement } from '/src/paneArrangement.ts';
import '/src/styles.css';

const ids = Array.from({ length: 14 }, (_, i) => `p${i}`);
const all = [...ids, 'other-section', 'popped-out'];
const initial = () => ({ mode: 'grid', order: [...ids], zoom: 1, focusShare: 0.58 });
const mounts = {};
const unmounts = {};
const clicks = [];
const popouts = [];

document.head.insertAdjacentHTML('beforeend', `<style>
  html, body, #root { width:100%; height:100%; margin:0; overflow:hidden; }
  .pane-map-probe { box-sizing:border-box; width:100%; height:100%; overflow:hidden;
    border:1px solid #525d72; border-radius:8px; background:#151e2e; color:#f0f4fb;
    padding:0; font:16px system-ui; }
  .pane-map-probe .pane-head { box-sizing:border-box; height:28px; padding:0 8px;
    gap:4px; line-height:1; user-select:none; }
  .pane-map-probe .pane-head button { margin-left:auto; width:20px; height:20px; padding:0; }
  .pane-map-probe textarea { display:block; box-sizing:border-box; width:100%; height:70px;
    margin-top:12px; background:#202d42; color:#f0f4fb; border:1px solid #75849a; }
</style>`);

function Probe({ id }) {
  useEffect(() => {
    mounts[id] = (mounts[id] || 0) + 1;
    return () => { unmounts[id] = (unmounts[id] || 0) + 1; };
  }, [id]);
  return <div className="pane-map-probe" data-id={id}>
    <div className="pane-head"><span>{id}</span><button aria-label={`Probe action ${id}`} onClick={() => clicks.push(id)}>+</button></div>
    <textarea aria-label={`Draft ${id}`} defaultValue="" />
  </div>;
}

function Harness() {
  const [arrangement, setArrangement] = useState(initial);
  const [mounted, setMounted] = useState(all);
  const [active, setActive] = useState(['p0']);
  const [maximized, setMaximized] = useState(null);
  const [onScreenPanes, setOnScreenPanes] = useState([]);
  const handle = useRef(null);
  const restores = useRef(0);
  const wheelEvents = useRef([]);
  const keyEvents = useRef([]);
  useEffect(() => {
    const wheel = event => wheelEvents.current.push({ prevented: event.defaultPrevented, ctrl: event.ctrlKey, deltaY: event.deltaY });
    const key = event => keyEvents.current.push({ key: event.key, target: event.target.tagName, prevented: event.defaultPrevented });
    window.addEventListener('wheel', wheel);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('wheel', wheel); window.removeEventListener('keydown', key); };
  }, []);
  const area = () => {
    const root = document.querySelector('[data-pane-map-region]');
    return { w: root.clientWidth, h: root.clientHeight };
  };
  const placement = () => place(arrangement, area());
  const rect = element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  };
  window.fixture = {
    reset(options = {}) {
      restores.current = 0;
      wheelEvents.current = [];
      keyEvents.current = [];
      clicks.length = 0;
      popouts.length = 0;
      setArrangement({ ...initial(), ...options.arrangement });
      setMounted(all);
      setActive(options.active || ['p0']);
      setMaximized(options.maximized || null);
    },
    setMode: mode => setArrangement(value => ({ ...value, mode, zoom: 1 })),
    setOrder: order => setArrangement(value => ({ ...value, order })),
    setActive,
    setMaximized,
    step: direction => setArrangement(value => ({ ...value, zoom: stepZoom(value, area(), direction) })),
    reveal: id => handle.current.reveal(id),
    addPane(id) {
      setMounted(value => [...value, id]);
      setActive([id]);
      setArrangement(value => ({ ...value, order: [id, ...value.order] }));
      requestAnimationFrame(() => handle.current.reveal(id));
    },
    snapshot() {
      const root = document.querySelector('[data-pane-map-region]');
      const p = placement();
      const panes = Object.fromEntries([...document.querySelectorAll('.pane-map-slot[data-pane-id]')].map(el => [el.dataset.paneId, {
        ...rect(el), display: getComputedStyle(el).display, transition: getComputedStyle(el).transitionDuration,
        parent: el.parentElement === root,
      }]));
      return {
        arrangement, active, maximized, onScreenPanes, mounts: { ...mounts }, unmounts: { ...unmounts }, restores: restores.current,
        root: rect(root), region: p.region, axis: p.axis, level: p.levels[p.levelIdx], levelIdx: p.levelIdx,
        scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, snaps: p.snaps, panes,
        drafts: Object.fromEntries([...document.querySelectorAll('[data-id] textarea')].map(el => [el.parentElement.dataset.id, el.value])),
        wheelEvents: [...wheelEvents.current],
        keyEvents: [...keyEvents.current],
        clicks: [...clicks], popouts: [...popouts],
      };
    },
  };
  return <PaneMap arrangement={arrangement} mounted={mounted} onArrangement={next => setArrangement(validArrangement(next, next.order))}
    active={active} maximized={maximized} onVisiblePanes={setOnScreenPanes} onRestore={() => { restores.current += 1; }}
    renderPane={id => <Probe id={id} />} onPopOut={(...args) => popouts.push(args)} handle={handle} />;
}

createRoot(document.getElementById('root')).render(<Harness />);
