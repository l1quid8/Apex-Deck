import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { frameDocument } from '../src/artifactFrame.ts';
// Electron needs a graphical session on Linux, even for a hidden window.
// macOS runs the regression normally; headless Linux still runs the pure tests.
const headlessLinux = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
test('artifact isolation blocks parser and navigation escapes while interactive HTML and SVG render', {
  skip: headlessLinux ? 'Electron requires DISPLAY or WAYLAND_DISPLAY on Linux' : false,
  timeout: 20000,
}, async () => {
  const require = createRequire(import.meta.url);
  const electron = require('electron');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-artifact-review-'));
  const sources = ['<!doctype html><html lang="en"><head><title>Normal document</title></head>', '<!-- <head> -->', '<img src="http://127.0.0.1:PORT/early"><head>', '<script src="http://127.0.0.1:PORT/code"></script><head>', '<textarea><head></textarea>', '<script type="text/plain"><head></script>'];
  const escapePage = JSON.stringify('<script>fetch("http://127.0.0.1:PORT/escaped-fetch",{mode:"no-cors"})</script>').replaceAll('<', '\\u003c');
  const navigations = [
    ['http', '"http://127.0.0.1:PORT/navigation"'],
    ['data', `'data:text/html,' + encodeURIComponent(${escapePage})`],
    ['blob', `URL.createObjectURL(new Blob([${escapePage}], {type:'text/html'}))`],
  ];
  const fixtures = [
    ...sources.map((prefix, i) => ({ label: 'parser-' + i, kind: 'html', document: frameDocument('html', prefix + '<body><h1>Rendered</h1><button onclick="this.textContent=\'Clicked\'">Click</button><script>document.body.dataset.ran="yes";try{parent.document.body.textContent="escaped"}catch{document.body.dataset.isolated="yes"}fetch("http://127.0.0.1:PORT/bypass",{mode:"no-cors"})</script></body>') })),
    { label: 'svg', kind: 'svg', document: frameDocument('svg', '<svg viewBox="0 0 10 10"><circle r="5"/></svg>') },
    ...navigations.map(([name, destination]) => ({ label: name, kind: 'navigation', document: frameDocument('html', `<h1>Navigation attempt</h1><script>top.postMessage("attempt:${name}","*");setTimeout(()=>{location.href=${destination}},10)</script>`) })),
  ];
  fs.writeFileSync(path.join(temp, 'main.cjs'), `
  const { app, BrowserWindow } = require('electron');
  const http = require('node:http');
  const fixtures = ${JSON.stringify(fixtures)};
  app.whenReady().then(async () => {
    const hits = [];
    let port;
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/parent')) {
        const doc = fixtures[Number(req.url.slice('/parent'.length))].document.replaceAll('PORT', port);
        res.setHeader('Content-Type', 'text/html');
        res.end('<iframe sandbox="allow-scripts" id="f"></iframe><script>window.artifactAttempts=[];addEventListener("message",e=>window.artifactAttempts.push(e.data));document.getElementById("f").srcdoc=atob("' + Buffer.from(doc).toString('base64') + '");<' + '/script>');
      } else { hits.push(req.url); res.end('ok'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const blocked = [];
    win.webContents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (!mainFrame && description === 'ERR_BLOCKED_BY_CSP') blocked.push({ code, url });
    });
    let code = 0; const results = [];
    try {
      for (let i = 0; i < fixtures.length; i++) {
        const fixture = fixtures[i];
        const blockedBefore = blocked.length;
        await win.loadURL('http://127.0.0.1:' + port + '/parent' + i);
        await new Promise(resolve => setTimeout(resolve, 250));
        const wrapper = win.webContents.mainFrame.frames[0];
        const inner = wrapper?.frames[0];
        if (!inner) throw Error('Missing isolated child for ' + fixture.label);
        let ok;
        if (fixture.kind === 'navigation') {
          const attempts = await win.webContents.executeJavaScript('window.artifactAttempts');
          // Electron retains the attempted URL on a blocked error document.
          // Require the actual CSP load rejection, not the frame's URL alone.
          ok = attempts.includes('attempt:' + fixture.label)
            && blocked.slice(blockedBefore).some(failure => failure.url === inner.url);
        } else {
          ok = await inner.executeJavaScript(fixture.kind === 'svg'
            ? '!!document.querySelector("svg circle")'
            : 'document.querySelector("button").click(); document.body.dataset.ran === "yes" && document.body.dataset.isolated === "yes" && !!document.querySelector("h1") && document.querySelector("button").textContent === "Clicked"');
        }
        results.push({ label: fixture.label, ok, url: inner.url });
      }
      console.log(JSON.stringify({ hits, results }));
      code = hits.filter(hit => hit !== '/favicon.ico').length === 0 && results.every(result => result.ok) ? 0 : 1;
    } catch (error) { console.error(error.stack); code = 1; }
    finally { win.destroy(); server.close(); app.exit(code); }
  });
  `);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.join(temp, 'main.cjs'), '--user-data-dir=' + path.join(temp, 'profile')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', bytes => output += bytes);
      child.stderr.on('data', bytes => output += bytes);
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    console.log(JSON.stringify(result));
    if (result.code !== 0) throw new Error('Artifact isolation/rendering regression: ' + result.output);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }

});
