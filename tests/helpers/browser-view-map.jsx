import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserView } from '/src/BrowserView.tsx';
import { PreviewPane } from '/src/PreviewPane.tsx';

const fullWindowScenario = new URL(location.href).searchParams.has('full-window');
if (fullWindowScenario) await import('/src/styles.css');

const calls = [];
const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="teal"/></svg>');
const rect = element => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};
const record = (kind, details = {}) => calls.push({ kind, ...details, region: rect(document.getElementById('region')) });
// Only the native view boundary is replaced. Layout, observers, animation,
// scrolling and BrowserView's snapshot rendering all run in real Chromium.
const browser = {
  async show(pane, bounds, url) { record('show', { pane, bounds, url }); },
  bounds(pane, bounds) { record('bounds', { pane, bounds }); },
  async hide(pane, snapshot) { record('hide', { pane, snapshot }); return snapshot ? picture : null; },
  async navigate() {}, async reload() {}, async back() {}, async forward() {},
  async close(pane) { record('close', { pane }); },
  onState() { return () => {}; },
  zoom() { return 1; },
};

document.head.insertAdjacentHTML('beforeend', `<style>
  html, body, #root { width:100%; height:100%; margin:0; overflow:hidden; }
  #region { position:absolute; left:80px; top:80px; width:800px; height:500px; overflow:auto; }
  #space { position:absolute; left:0; top:0; width:800px; height:1200px; }
  #slot { position:absolute; display:flex; left:100px; top:80px; width:300px; height:200px; }
  #slot > .browser-place, .browser-snapshot { display:block; width:100%; height:100%; }
  #slot.glide { transition:left 220ms linear; }
</style>`);

function Harness() {
  return <div data-pane-map-region data-moving="">
    <div id="region" data-pane-map-region>
      <div id="space" />
      <div id="slot">{fullWindowScenario ? <PreviewPane
        pane={{id:'preview', workspaceId:'fixture', kind:'preview', title:'Fixture page', url:'https://preview.invalid/'}}
        backend={{browser}} visible servers={[]} source={null} openExternally={[]}
        onOpenExternallyChange={() => {}} onAddress={() => {}} onStatus={() => {}}
        onStartSource={() => {}} onShowSource={() => {}} onOpenInBrowser={() => {}}
      /> : <BrowserView pane="preview" url="https://preview.invalid/" browser={browser} visible onState={() => {}} />}</div>
    </div>
  </div>;
}

window.fixture = {
  snapshot() {
    return {
      calls: [...calls],
      placeholder: rect(document.querySelector('.browser-place')),
      region: rect(document.getElementById('region')),
      scrollTop: document.getElementById('region').scrollTop,
      picture: document.querySelector('.browser-snapshot')?.getAttribute('src') || null,
    };
  },
  moving(value) { document.getElementById('region').toggleAttribute('data-moving', value); },
  glide() {
    const slot = document.getElementById('slot');
    slot.classList.add('glide');
    slot.getBoundingClientRect();
    slot.style.left = '450px';
    return new Promise(resolve => slot.addEventListener('transitionend', resolve, { once: true }));
  },
  async scrollEndGeometry() {
    // Position-only compositor animation changes no observed DOM attributes
    // and no dimensions. scrollend must be enough to re-read its final rect.
    const animation = document.getElementById('slot').animate([{ left:'100px' }, { left:'450px' }], { duration:80, fill:'forwards' });
    await animation.finished;
    document.getElementById('region').dispatchEvent(new Event('scrollend'));
  },
};

createRoot(document.getElementById('root')).render(<Harness />);
