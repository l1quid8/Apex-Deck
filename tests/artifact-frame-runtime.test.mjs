import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { frameDocument } from '../src/artifactFrame.ts';
const require = createRequire(import.meta.url);
const electron = require('electron');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-artifact-review-'));
const sources = ['<!doctype html><html lang="en"><head><title>Normal document</title></head>', '<!-- <head> -->', '<img src="http://127.0.0.1:PORT/early"><head>', '<script src="http://127.0.0.1:PORT/code"></script><head>', '<textarea><head></textarea>', '<script type="text/plain"><head></script>'];
const docs = [
  ...sources.map(prefix => frameDocument('html', prefix + '<body><h1>Rendered</h1><script>document.body.dataset.ran="yes";fetch("http://127.0.0.1:PORT/bypass",{mode:"no-cors"})</script></body>')),
  frameDocument('svg', '<svg viewBox="0 0 10 10"><circle r="5"/></svg>'),
];
fs.writeFileSync(path.join(temp, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const docs = ${JSON.stringify(docs)};
app.whenReady().then(async () => {
  const hits = [];
  let port;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/parent')) {
      const doc = docs[Number(req.url.at(-1))].replaceAll('PORT', port);
      res.setHeader('Content-Type', 'text/html');
      res.end('<iframe sandbox="allow-scripts" id="f"></iframe><script>document.getElementById("f").srcdoc=atob("' + Buffer.from(doc).toString('base64') + '");<' + '/script>');
    } else { hits.push(req.url); res.end('ok'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  let code = 0; const rendered = [];
  try {
    for (let i = 0; i < docs.length; i++) {
      await win.loadURL('http://127.0.0.1:' + port + '/parent' + i);
      await new Promise(resolve => setTimeout(resolve, 250));
      const frames = win.webContents.mainFrame.frames;
      rendered.push(await frames[0].executeJavaScript(i === docs.length - 1 ? '!!document.querySelector("svg circle")' : 'document.body.dataset.ran === "yes" && !!document.querySelector("h1")'));
    }
    console.log(JSON.stringify({ hits, rendered }));
    code = hits.filter(hit => hit !== '/favicon.ico').length === 0 && rendered.every(Boolean) ? 0 : 1;
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
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  console.log(JSON.stringify(result));
  if (result.code !== 0) throw new Error('Artifact isolation/rendering regression: ' + result.output);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
