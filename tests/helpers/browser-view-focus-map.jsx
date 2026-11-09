import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PaneMap } from '/src/PaneMap.tsx';
import { BrowserView } from '/src/BrowserView.tsx';
import '/src/styles.css';

const ids = Array.from({ length: 14 }, (_, i) => `p${i}`);
const calls = [];
const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="teal"/></svg>');
const rect = element => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};
const region = () => document.querySelector('[data-pane-map-region]');
const record = (kind, pane, details = {}) => calls.push({ kind, pane, ...details, scrollTop:region().scrollTop, region: rect(region()) });
// The native view is the only replaced boundary. Both components, layout,
// scrolling, observers, transitions and pointer handling run in Chromium.
const browser = {
  async show(pane, bounds, url) { record('show', pane, { bounds, url }); },
  bounds(pane, bounds) { record('bounds', pane, { bounds }); },
  async hide(pane, snapshot) { record('hide', pane, { snapshot }); return snapshot ? picture : null; },
  async navigate() {}, async reload() {}, async back() {}, async forward() {},
  async close(pane) { record('close', pane); },
  onState() { return () => {}; },
  zoom() { return 1; },
};

document.head.insertAdjacentHTML('beforeend', `<style>
  html, body, #root { width:100%; height:100%; margin:0; overflow:hidden; }
  .focus-browser-probe { display:flex; flex-direction:column; width:100%; height:100%; overflow:hidden; background:#151e2e; color:white; }
  .focus-browser-probe .pane-head { box-sizing:border-box; height:28px; min-height:28px; padding:0 8px; user-select:none; }
  .focus-browser-probe .browser-place { flex:1; min-height:0; width:100%; }
  .focus-browser-probe .browser-snapshot { display:block; width:100%; height:100%; }
</style>`);

const renderPane = (id, _rect, onScreen) => <div className="focus-browser-probe" data-probe={id}>
  <div className="pane-head">{id}</div>
  {(id === 'p0' || id === 'p1') && <BrowserView pane={id} url={`https://${id}.invalid/`} browser={browser} visible={onScreen} onState={() => {}} />}
</div>;

function Harness() {
  const [arrangement, setArrangement] = useState({ mode:'left', order:ids, zoom:1, focusShare:0.58 });
  const handle = useRef(null);
  window.fixture = {
    clearCalls() { calls.length = 0; },
    setMode(mode) { setArrangement(value => ({ ...value, mode })); },
    reset() {
      region().scrollTop = 0;
      setArrangement({ mode:'left', order:ids, zoom:1, focusShare:0.58 });
    },
    snapshot() {
      const map = region();
      return {
        calls:[...calls], arrangement, scrollTop:map.scrollTop,
        moving:map.hasAttribute('data-moving'), focusMoving:map.hasAttribute('data-focus-moving'),
        region:rect(map), divider:rect(document.querySelector('.pane-map-divider')),
        panes:Object.fromEntries([...document.querySelectorAll('[data-pane-id]')].map(slot => [slot.dataset.paneId, {
          rect:rect(slot), pinned:slot.hasAttribute('data-pinned'),
          placeholder:slot.querySelector('.browser-place') ? rect(slot.querySelector('.browser-place')) : null,
          picture:slot.querySelector('.browser-snapshot')?.getAttribute('src') || null,
          transition:getComputedStyle(slot).transitionDuration,
        }])),
      };
    },
  };
  return <PaneMap arrangement={arrangement} mounted={ids} onArrangement={setArrangement} active={['p0']}
    maximized={null} onRestore={() => {}} renderPane={renderPane} onPopOut={() => {}} handle={handle} />;
}

createRoot(document.getElementById('root')).render(<Harness />);
