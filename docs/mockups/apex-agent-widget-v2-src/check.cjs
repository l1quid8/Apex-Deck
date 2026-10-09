// Electron checker for the ApexAgent mockup (v1 checks + v2 checks). Usage:
//   /Users/tylercaldwell/Downloads/apex-deck/node_modules/.bin/electron /tmp/jigga-aa2/qa/check.cjs <html-file> <out-dir>
const {app, BrowserWindow} = require('electron');
const fs = require('fs');
const path = require('path');

const argv = process.argv;
const ci = argv.findIndex(a => a.endsWith('check.cjs'));
const args = ci >= 0 ? argv.slice(ci + 1) : argv.slice(2);
const FILE = args[0] ? path.resolve(args[0]) : null;
const OUT = args[1] ? path.resolve(args[1]) : null;
if (!FILE || !OUT) { console.error('usage: electron check.cjs <html-file> <out-dir>'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CATS = ['consoleErrors', 'setup', 'offscreen', 'clippedText', 'clippedY', 'overlap',
  'bannedClass', 'unprefixedClass', 'smallText', 'lowContrast', 'tinyButton',
  'glowOverflow', 'ellipsis', 'shortcutJ', 'keyboard', 'projectIsolation', 'dropFlow', 'browserCover'];
// Categories filled only by the run-once phase (shortcutJ also has a per-step text check).
const ONCE_CATS = ['keyboard', 'projectIsolation', 'dropFlow', 'browserCover'];
const SHORT = {consoleErrors:'a', offscreen:'b', clippedText:'c', clippedY:'c-y', overlap:'d',
  bannedClass:'e', unprefixedClass:'e-prefix', smallText:'f', lowContrast:'g', tinyButton:'h', setup:'setup',
  glowOverflow:'i', ellipsis:'j', shortcutJ:'k', keyboard:'l', projectIsolation:'m', dropFlow:'n', browserCover:'o'};

// Built-in state scenarios, used only when window.STEPS is empty.
const BASE = "AA.set({open:false,status:'watching',needs:0,size:'compact',tab:'chat',hidden:false,pos:{edge:'right',y:420},setup:'none',switcher:false,messages:[]});";
const SCEN = [
  {name:'closed-watching', title:'Closed, watching', note:'avatar only', js: BASE},
  {name:'needs2-bubble', title:'needs:2 with a bubble', note:'decision bubble', js: BASE +
    "AA.set({status:'needs',needs:2}); AA.bubble({id:'qa-b1',text:'SSO tests are failing. Defer SSO, keep November 1?',tone:'decision'});"},
  {name:'open-chat-blocker', title:'Open chat with blocker', note:'blocker message', js: BASE +
    "AA.set({open:true,status:'needs',needs:1}); AA.addMessage({from:'agent',kind:'blocker',text:'SSO tests are failing: 3 of 12. The launch plan says SSO must ship before Nov 1. Defer SSO, keep November 1, and draft the revised plan.',status:'open',evidence:[{label:'test-report.md',quote:'SSO login: 3 of 12 failing',line:14},{label:'docs/launch-plan.md',quote:'SSO must ship before release',line:22}]});"},
  {name:'open-activity', title:'Open, Activity tab', note:'', js: BASE + "AA.set({open:true,tab:'activity'});"},
  {name:'open-settings', title:'Open, Settings tab', note:'', js: BASE + "AA.set({open:true,tab:'settings'});"},
  {name:'tall', title:'Tall size', note:'', js: BASE + "AA.set({open:true,size:'tall',tab:'chat'});"},
  {name:'left-edge', title:'Left edge', note:'', js: BASE + "AA.set({open:true,pos:{edge:'left',y:300},tab:'chat'});"},
  {name:'hidden', title:'Hidden (edge tab)', note:'', js: BASE + "AA.set({hidden:true});"}
];

// Runs inside the page. Must be self-contained (serialized with toString).
function PAGE_CHECK() {
  var layer = document.getElementById('aa-layer');
  var out = {findings: {}, visibleCount: 0};
  function add(cat, s) { (out.findings[cat] = out.findings[cat] || []).push(s); }
  if (!layer) { add('setup', 'no #aa-layer element'); return out; }
  var L = layer.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight;
  function r4(r) { return '[' + [r.left, r.top, r.width, r.height].map(function (v) { return Math.round(v); }).join(',') + ']'; }
  function snip(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    var c = (el.getAttribute('class') || '').trim();
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c.split(/\s+/).join('.') : '') + (t ? ' "' + t + '"' : '');
  }
  function isVis(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  var all = Array.prototype.slice.call(layer.querySelectorAll('*'));
  var visAll = all.filter(isVis);
  out.visibleCount = visAll.length;

  // b. off-screen: visible element whose rect pokes outside the layer by >2px
  // The rect is first clipped by any in-layer ancestor with overflow hidden/auto/scroll, so scroll content
  // that is hidden inside its panel does not count. Fully clipped elements are skipped (counted in clippedAway).
  function clipRect(el) {
    var r = el.getBoundingClientRect();
    var x = {l: r.left, t: r.top, r: r.right, b: r.bottom};
    for (var p = el.parentElement; p && p !== layer; p = p.parentElement) {
      var cs = getComputedStyle(p);
      if (/hidden|auto|scroll|clip/.test(cs.overflowX + ' ' + cs.overflowY)) {
        var q = p.getBoundingClientRect();
        x = {l: Math.max(x.l, q.left), t: Math.max(x.t, q.top), r: Math.min(x.r, q.right), b: Math.min(x.b, q.bottom)};
      }
    }
    return x;
  }
  visAll.forEach(function (el) {
    var c = clipRect(el);
    if (c.r <= c.l || c.b <= c.t) { out.clippedAway = (out.clippedAway || 0) + 1; return; }
    if (c.l < L.left - 2 || c.r > L.right + 2 || c.t < L.top - 2 || c.b > L.bottom + 2)
      add('offscreen', snip(el) + ' visible=' + r4({left: c.l, top: c.t, width: c.r - c.l, height: c.b - c.t}) + ' layer=' + r4(L));
  });

  // c. clipped text: overflow hidden, scrollWidth > clientWidth, no ellipsis
  visAll.forEach(function (el) {
    var cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis') return;
    if ((el.textContent || '').trim() === '') return;
    var ovx = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    var ovy = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    if (ovx && el.scrollWidth > el.clientWidth + 1) add('clippedText', snip(el) + ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth);
    if (ovy && el.scrollHeight > el.clientHeight + 1) add('clippedY', snip(el) + ' scrollH=' + el.scrollHeight + ' clientH=' + el.clientHeight);
  });

  // d. overlap: avatar (first visible child of #av-mount) vs panel (first visible child of #cv-mount) or bubbles
  function firstVis(p) { return p ? (Array.prototype.slice.call(p.children).filter(isVis)[0] || null) : null; }
  function ovl(a, b) {
    var A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
    var w = Math.min(A.right, B.right) - Math.max(A.left, B.left);
    var h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    return {w: w, h: h, m: Math.min(w, h)};
  }
  var av = firstVis(document.getElementById('av-mount'));
  var cv = firstVis(document.getElementById('cv-mount'));
  var bbs = Array.prototype.slice.call(document.getElementById('bb-mount').children).filter(isVis);
  if (av) {
    if (cv) { var o = ovl(av, cv); if (o.m > 4) add('overlap', 'avatar ' + snip(av) + ' x panel ' + snip(cv) + ' overlap ' + Math.round(o.w) + 'x' + Math.round(o.h)); }
    bbs.forEach(function (b) { var o2 = ovl(av, b); if (o2.m > 4) add('overlap', 'avatar x bubble ' + snip(b) + ' overlap ' + Math.round(o2.w) + 'x' + Math.round(o2.h)); });
  }

  // e. banned class names, and any class token not prefixed av-/cv-/su-/bb-/cf-/aa-
  var BANNED = ['badge', 'picker', 'row', 'mono', 'card', 'active', 'selected', 'open', 'tab'];
  all.forEach(function (el) {
    var c = (el.getAttribute('class') || '').trim();
    if (!c) return;
    c.split(/\s+/).forEach(function (t) {
      if (BANNED.indexOf(t) >= 0) add('bannedClass', snip(el) + ' class="' + t + '"');
      if (!/^(av-|cv-|su-|bb-|cf-|aa-)/.test(t)) add('unprefixedClass', snip(el) + ' class="' + t + '"');
    });
  });

  // collect elements that directly hold non-empty text
  var tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, null);
  var seen = new Set(), textEls = [], n;
  while ((n = tw.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    var p = n.parentElement;
    if (!p || seen.has(p) || p.closest('script,style')) continue;
    seen.add(p); textEls.push(p);
  }

  // f. small text
  textEls.forEach(function (p) {
    if (!isVis(p)) return;
    var fs = parseFloat(getComputedStyle(p).fontSize);
    if (fs < 11) add('smallText', fs + 'px ' + snip(p));
  });

  // g. low contrast (approximate: nearest opaque-ish background, opacity folded into text alpha)
  var cx = document.createElement('canvas').getContext('2d');
  function norm(s) {
    cx.fillStyle = '#000'; cx.fillStyle = s;
    var v = cx.fillStyle, m;
    if (v.charAt(0) === '#') return {r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: 1};
    m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var q = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return {r: q[0], g: q[1], b: q[2], a: q.length > 3 ? q[3] : 1};
  }
  var base = norm(getComputedStyle(document.body).backgroundColor) || {r: 0, g: 0, b: 0, a: 1};
  function bgOf(el) {
    var layers = [], e = el;
    while (e && e.nodeType === 1) {
      var c = norm(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
      e = e.parentElement;
    }
    var o = {r: base.r * base.a, g: base.g * base.a, b: base.b * base.a};
    for (var i = layers.length - 1; i >= 0; i--) {
      var l = layers[i];
      o = {r: l.r * l.a + o.r * (1 - l.a), g: l.g * l.a + o.g * (1 - l.a), b: l.b * l.a + o.b * (1 - l.a)};
    }
    return o;
  }
  function lum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) { var l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  textEls.forEach(function (p) {
    if (!isVis(p)) return;
    var R = p.getBoundingClientRect();
    var ix = Math.min(R.right, vw) - Math.max(R.left, 0), iy = Math.min(R.bottom, vh) - Math.max(R.top, 0);
    if (ix <= 0 || iy <= 0) { out.skippedOffViewport = (out.skippedOffViewport || 0) + 1; return; }
    var cs = getComputedStyle(p);
    var fg = norm(cs.color);
    if (!fg) return;
    var op = 1;
    for (var e = p; e && e !== document.documentElement; e = e.parentElement) op *= (parseFloat(getComputedStyle(e).opacity) || 1);
    var a = fg.a * op;
    var bg = bgOf(p);
    var comp = {r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a)};
    var fs = parseFloat(cs.fontSize), need = fs < 14 ? 4.5 : 3;
    var rt = ratio(comp, bg);
    if (rt < need) add('lowContrast', rt.toFixed(2) + ':1 need ' + need + ' fs=' + fs + ' ' + snip(p));
  });

  // h. tiny buttons (< 24x24)
  layer.querySelectorAll('button,[role="button"]').forEach(function (el) {
    if (!isVis(el)) return;
    var r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) add('tinyButton', snip(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  });

  // i. ellipsis: FAIL when a text-overflow:ellipsis element is cut off now; WARN when it sits in an
  // av/cv/su/bb/cf part and has ellipsis even though it fits (G: no cut-off text in the parts)
  function partOf(el) {
    for (var q = el; q && q !== layer; q = q.parentElement) {
      if (/(^|\s)(av|cv|su|bb|cf)-/.test(q.getAttribute('class') || '')) return true;
    }
    return false;
  }
  Array.prototype.slice.call(document.querySelectorAll('*')).forEach(function (el) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') return;
    if (!isVis(el)) return;
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (el.scrollWidth > el.clientWidth + 1)
      add('ellipsis', 'FAIL cut off "' + t.slice(0, 120) + '" ' + snip(el) + ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth);
    else if (layer.contains(el) && partOf(el))
      add('ellipsis', 'WARN ellipsis rule in a part (fits now, but may cut text) "' + t.slice(0, 120) + '" ' + snip(el));
  });

  // j. shortcut text: the visible page must never advertise Cmd+J
  var bodyText = (document.body && document.body.innerText) || '';
  if (/⌘\s?J|Cmd\+J/.test(bodyText)) add('shortcutJ', 'visible text mentions the Cmd+J shortcut (⌘J)');
  return out;
}

// Runs inside the page: returns the list of avatar/bubble/panel elements outside the window right now.
function GLOW_SAMPLE() {
  var out = [], vw = window.innerWidth, vh = window.innerHeight;
  ['av-mount', 'bb-mount', 'cv-mount'].forEach(function (id) {
    var root = document.getElementById(id); if (!root) return;
    Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
        var c = (el.getAttribute('class') || '').trim();
        out.push(id + ' ' + el.tagName.toLowerCase() + (c ? '.' + c.split(/\s+/).join('.') : '') +
          ' rect=[' + [r.left, r.top, r.right, r.bottom].map(function (v) { return Math.round(v); }).join(',') +
          '] window=' + vw + 'x' + vh);
      }
    });
  });
  return out;
}

// ---------- run-once checks (each self-contained; returns {<category>: [finding strings]}) ----------

async function ONCE_KEYBOARD() {
  var out = {keyboard: []};
  var F = function (s) { out.keyboard.push(s); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var desc = function (el) { return el ? el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') : 'nothing'; };
  if (!document.querySelector('.av-hit')) { F('no .av-hit button'); return out; }
  AA.set({open: false}); await wait(150);
  var hit = document.querySelector('.av-hit'); hit.focus(); await wait(50);
  hit.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  hit = document.querySelector('.av-hit') || hit;
  hit.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 0}));
  await wait(250);
  if (AA.state.open !== true) F('Enter (keydown) plus the click did not open the panel (open=' + AA.state.open + '); check for a double toggle');
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
  await wait(250);
  if (AA.state.open) F('Escape did not close the panel');
  var a = document.activeElement;
  if (!a || !a.classList || !a.classList.contains('av-hit')) F('after Escape, focus is on ' + desc(a) + ' and not on the avatar (.av-hit)');
  hit = document.querySelector('.av-hit');
  if (hit) hit.focus();
  var y0 = AA.state.pos.y;
  if (hit) hit.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true, cancelable: true}));
  await wait(200);
  if (AA.state.pos.y === y0) F('ArrowUp did not move the avatar (pos.y stayed ' + y0 + ')');
  return out;
}

async function ONCE_SHORTCUT() {
  var out = {shortcutJ: []};
  var F = function (s) { out.shortcutJ.push(s); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  AA.set({open: false}); await wait(150);
  var before = !!AA.state.open;
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'j', metaKey: true, bubbles: true, cancelable: true}));
  await wait(200);
  if (!!AA.state.open !== before) F('Cmd+J toggled the panel (Cmd+J belongs to Deck, the shortcut is Cmd+K)');
  var mid = !!AA.state.open;
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', metaKey: true, bubbles: true, cancelable: true}));
  await wait(200);
  if (!!AA.state.open === mid) F('Cmd+K did not toggle the panel');
  return out;
}

async function ONCE_PROJECT() {
  var out = {projectIsolation: []};
  var F = function (s) { out.projectIsolation.push(s); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  if (typeof AA.switchProject !== 'function' || typeof AA.loadProjects !== 'function') { F('no per-project scope'); return out; }
  if (AA.state.project !== 'mobile') AA.switchProject('mobile');
  AA.loadProjects({
    mobile: {setup: 'done', status: 'watching', messages: [{id: 'qa-m', from: 'agent', kind: 'text', text: 'QA-MOBILE-ONLY', time: '1'}]},
    deck: {setup: 'done', status: 'watching', messages: [{id: 'qa-d', from: 'agent', kind: 'text', text: 'QA-DECK-ONLY', time: '1'}]}
  });
  AA.set({open: true, tab: 'chat', switcher: false}); await wait(300);
  var sw = document.querySelector('#cv-mount [data-cv-act="switch"]');
  if (!sw) { F('no project switch control in the panel header'); return out; }
  sw.click(); await wait(300);
  var cands = Array.prototype.slice.call(document.querySelectorAll('#cv-mount *')).filter(function (el) {
    if (sw.contains(el) || el.contains(sw)) return false;
    var r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false;
    var t = (el.textContent || '').trim();
    if (t.indexOf('Apex Deck') !== 0) return false;
    return !Array.prototype.some.call(el.children, function (c) { return (c.textContent || '').trim().indexOf('Apex Deck') === 0; });
  });
  if (!cands.length) { F('no "Apex Deck" entry in the project switcher after clicking the project chip'); return out; }
  cands[0].click(); await wait(400);
  if (AA.state.project !== 'deck') F('after choosing Apex Deck, AA.state.project is "' + AA.state.project + '", not "deck"');
  var txt = (document.getElementById('cv-mount') && (document.getElementById('cv-mount').innerText || document.getElementById('cv-mount').textContent)) || '';
  if (txt.indexOf('QA-MOBILE-ONLY') >= 0) F('panel still shows the Mobile launch message QA-MOBILE-ONLY after switching to Apex Deck');
  if (txt.indexOf('QA-DECK-ONLY') < 0) F('panel does not show the Apex Deck message QA-DECK-ONLY after switching');
  return out;
}

async function ONCE_DROP() {
  var out = {dropFlow: []};
  var F = function (s) { out.dropFlow.push(s); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  if (typeof AA.addSource !== 'function') { F('no addSource'); return out; }
  if (AA.state.project !== 'mobile' && typeof AA.switchProject === 'function') AA.switchProject('mobile');
  AA.set({open: true, tab: 'chat', sources: AA.state.sources.filter(function (s) { return !/CHANGELOG/.test((s.label || '') + (s.ref || '')); })});
  await wait(300);
  var events = [];
  AA.on('source-add', function (e) { events.push(e); });
  var text = function () { return document.body.innerText || ''; };
  var count = function (t, s) { return t.split(s).length - 1; };
  var t0 = text(), added0 = count(t0, 'Added CHANGELOG'), got0 = count(t0, 'Got it');
  var p1 = Promise.resolve(AA.addSource({kind: 'file', ref: 'CHANGELOG.md', label: 'CHANGELOG.md', project: 'mobile'}));
  var p2 = Promise.resolve(AA.addSource({kind: 'file', ref: 'CHANGELOG.md', label: 'CHANGELOG.md', project: 'mobile'}));
  var premature = function (when) {
    var t = text();
    if (count(t, 'Added CHANGELOG') > added0) F('premature success: "Added CHANGELOG" is visible ' + when);
    if (count(t, 'Got it') > got0) F('premature success: "Got it" is visible ' + when);
  };
  premature('immediately after the drop');
  await wait(800);
  premature('800ms after the drop');
  await wait(900);
  var r1 = await p1, r2 = await p2;
  var t2 = text();
  if (t2.indexOf('Added CHANGELOG.md') < 0) F('"Added CHANGELOG.md" never appeared after 1600ms');
  var n = AA.state.sources.filter(function (s) { return s.label === 'CHANGELOG.md' || /CHANGELOG\.md$/.test(s.ref || ''); }).length;
  if (n !== 1) F('expected exactly one CHANGELOG.md source in AA.state.sources, found ' + n);
  if (t2.toLowerCase().indexOf('already watching') < 0) F('the second drop did not say "already watching"');
  if (!events.some(function (e) { return e.phase === 'duplicate'; })) F('the second drop did not emit a duplicate source-add event');
  if (AA.state.sources.some(function (s) { return s.pending; })) F('a source is still pending after 1600ms');
  if (r2 && r2.ok) F('second addSource resolved ok:true (should be a duplicate)');
  return out;
}

async function ONCE_BROWSER() {
  var out = {browserCover: []};
  var F = function (s) { out.browserCover.push(s); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var rect = function (el) { return el ? el.getBoundingClientRect() : null; };
  var overlap = function (a, b) { return !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; };
  var frameOf = function () {
    var cv = document.getElementById('cv-mount'); if (!cv) return null;
    return Array.prototype.slice.call(cv.children).filter(function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })[0] || null;
  };
  if (typeof AA.page !== 'function') { F('no AA.page'); return out; }
  AA.page('browser'); await wait(400);
  var nat = document.querySelector('.sh-native');
  if (!nat) { F('no .sh-native on the browser page'); return out; }
  var hit = document.querySelector('.av-hit');
  if (!hit) { F('no .av-hit button on the browser page'); return out; }
  if (overlap(rect(hit), rect(nat))) F('avatar sits on top of the docked browser (.sh-native)');
  AA.set({open: true}); await wait(400);
  var frame = frameOf();
  if (!frame) F('no panel frame rendered after opening on the browser page');
  var frozen = document.documentElement.classList.contains('aa-browser-frozen');
  if (frame && overlap(rect(frame), rect(nat)) && !frozen) F('panel covers the docked browser but the page is not frozen (html lacks aa-browser-frozen; panel needs class aa-overlay)');
  AA.set({open: false}); await wait(400);
  if (document.documentElement.classList.contains('aa-browser-frozen')) F('page still frozen (aa-browser-frozen) after closing the panel');
  return out;
}

const ONCE = [
  {name: 'keyboard', cat: 'keyboard', fn: ONCE_KEYBOARD},
  {name: 'shortcutJ', cat: 'shortcutJ', fn: ONCE_SHORTCUT},
  {name: 'projectIsolation', cat: 'projectIsolation', fn: ONCE_PROJECT},
  {name: 'dropFlow', cat: 'dropFlow', fn: ONCE_DROP},
  {name: 'browserCover', cat: 'browserCover', fn: ONCE_BROWSER}
];
const SNAP_JS = "window.__qaSnap = JSON.parse(JSON.stringify(AA.state)); true;";
const RESTORE_JS = "(function(){ var s = window.__qaSnap; if (!s) return false; if (typeof AA.page === 'function') AA.page(s.page); AA.set(s); return true; })();";

let killer = null;
function arm(ms) {
  clearTimeout(killer);
  killer = setTimeout(() => { console.log('TIMEOUT: hard limit hit, exiting'); app.exit(2); }, ms);
}

async function run() {
  arm(120000);
  fs.mkdirSync(OUT, {recursive: true});
  const consoleBuf = [];
  const win = new BrowserWindow({width: 1440, height: 900, show: false,
    webPreferences: {offscreen: true, partition: 'qa-' + Date.now()}}); // in-memory partition: no localStorage carry-over
  const wc = win.webContents;
  wc.on('console-message', (...a) => {
    const ev = a[0] || {};
    let level = ev.level, message = ev.message;
    if (level === undefined) {
      if (a[1] && typeof a[1] === 'object') { level = a[1].level; message = a[1].message; }
      else { level = a[1]; message = a[2]; }
    }
    const bad = level === 'error' || (typeof level === 'number' && level >= 2);
    if (bad) consoleBuf.push(String(message));
  });
  wc.on('render-process-gone', (e, d) => consoleBuf.push('RENDER PROCESS GONE: ' + (d && d.reason)));
  await win.loadFile(FILE);
  wc.setZoomFactor(0.7);
  await sleep(300);
  const loadErrors = consoleBuf.splice(0);
  // load-time errors are reported under the first state so they show up in the per-state counts
  const steps = await wc.executeJavaScript('(window.STEPS||[]).map(function(s){return {title:s.title||"",note:s.note||""};})');
  const plan = steps.length
    ? steps.map((s, i) => ({name: 'step-' + (i + 1), title: s.title, note: s.note, js: 'go(' + i + ')'}))
    : SCEN.map(s => ({name: s.name, title: s.title, note: s.note, js: s.js}));
  arm(90000 + plan.length * 7000);
  const report = {file: FILE, mode: steps.length ? 'STEPS' : 'builtin-scenarios', loadErrors, steps: [], once: []};
  const totals = {};
  CATS.forEach(c => totals[c] = 0);
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (i === 0) consoleBuf.push(...loadErrors.map(e => 'LOAD: ' + e));
    let scenErr = null;
    try { await wc.executeJavaScript(p.js); } catch (e) { scenErr = String(e && e.message || e); }
    await sleep(900);
    const errs = consoleBuf.splice(0);
    if (scenErr) errs.push('SCENARIO THREW: ' + scenErr);
    // glowOverflow: sample 3 times, ~400ms apart, so pulse animations are caught mid-cycle
    const glowList = [], glowSeen = new Set();
    for (let k = 0; k < 3; k++) {
      if (k) await sleep(400);
      let g;
      try { g = await wc.executeJavaScript('(' + GLOW_SAMPLE.toString() + ')()'); }
      catch (e) { g = ['check threw: ' + (e && e.message)]; }
      g.forEach(s => { if (!glowSeen.has(s)) { glowSeen.add(s); glowList.push('sample ' + (k + 1) + ': ' + s); } });
    }
    errs.push(...consoleBuf.splice(0));
    let pc;
    try { pc = await wc.executeJavaScript('(' + PAGE_CHECK.toString() + ')()'); }
    catch (e) { pc = {findings: {setup: ['check threw: ' + e.message]}, visibleCount: -1}; }
    const img = await wc.capturePage();
    const pngName = 'step-' + String(i + 1).padStart(2, '0') + '.png';
    fs.writeFileSync(path.join(OUT, pngName), img.toPNG());
    const findings = Object.assign({consoleErrors: errs, glowOverflow: glowList}, pc.findings || {});
    const counts = {};
    Object.keys(findings).forEach(k => { counts[k] = findings[k].length; totals[k] = (totals[k] || 0) + findings[k].length; });
    CATS.forEach(c => { if (counts[c] === undefined) counts[c] = 0; });
    const capped = {};
    Object.keys(findings).forEach(k => { if (findings[k].length) capped[k] = findings[k].slice(0, 60); });
    report.steps.push({index: i + 1, name: p.name, title: p.title, note: p.note, png: pngName,
      visibleCount: pc.visibleCount, skippedOffViewport: pc.skippedOffViewport || 0, clippedAway: pc.clippedAway || 0, counts, findings: capped});
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  }

  // run-once checks, each from the same base state (state is snapshotted and restored around each one)
  try { await wc.executeJavaScript(plan[0].js); } catch (e) { /* base state failed; checks still run */ }
  await sleep(900);
  consoleBuf.splice(0);
  for (const o of ONCE) {
    let res = {};
    try { await wc.executeJavaScript(SNAP_JS); } catch (e) { /* snapshot failed */ }
    try { res = await wc.executeJavaScript('(' + o.fn.toString() + ')()'); }
    catch (e) { res = {}; res[o.cat] = ['check threw: ' + (e && e.message || e)]; }
    try { await wc.executeJavaScript(RESTORE_JS); } catch (e) { /* restore failed */ }
    const errs = consoleBuf.splice(0);
    const list = (res && res[o.cat]) || [];
    list.forEach(() => {});
    totals[o.cat] = (totals[o.cat] || 0) + list.length;
    if (errs.length) { totals.consoleErrors += errs.length; report.once.push({name: 'console during ' + o.name, cat: 'consoleErrors', findings: errs.slice(0, 60)}); }
    report.once.push({name: o.name, cat: o.cat, count: list.length, findings: list.slice(0, 60)});
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  }
  report.totals = totals;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  // readable summary
  const lines = [];
  lines.push('CHECK ' + FILE + ' (' + report.mode + ', ' + plan.length + ' states + run-once checks) -> ' + OUT);
  if (loadErrors.length) lines.push('load-time console errors: ' + loadErrors.join(' | '));
  const PER_STEP = CATS.filter(c => ONCE_CATS.indexOf(c) < 0);
  report.steps.forEach(s => {
    const parts = PER_STEP.map(c => SHORT[c] + ':' + s.counts[c]).join(' ');
    lines.push('');
    lines.push(String(s.index).padStart(2, '0') + ' ' + s.name + ' - ' + s.title + '  [visible=' + s.visibleCount + ']  ' + s.png);
    lines.push('   ' + parts);
    PER_STEP.forEach(c => {
      const arr = s.findings[c] || [];
      arr.slice(0, c === 'smallText' ? 10 : 3).forEach(f => lines.push('   [' + SHORT[c] + ' ' + c + '] ' + f));
    });
  });
  lines.push('');
  lines.push('RUN-ONCE CHECKS (from base state)');
  report.once.forEach(o => {
    lines.push('   ' + SHORT[o.cat] + ' ' + o.name + ': ' + (o.count !== undefined ? o.count : (o.findings || []).length));
    (o.findings || []).slice(0, 5).forEach(f => lines.push('   [' + SHORT[o.cat] + ' ' + o.cat + '] ' + f));
  });
  lines.push('');
  lines.push('TOTALS ' + CATS.map(c => SHORT[c] + ':' + totals[c]).join(' '));
  console.log(lines.join('\n'));
}

app.whenReady().then(async () => {
  try { await run(); }
  catch (e) { console.log('CHECKER ERROR: ' + (e && e.stack || e)); }
  clearTimeout(killer);
  app.quit();
});
