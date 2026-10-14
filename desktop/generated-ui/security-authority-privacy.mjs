// Diagnostic candidate only. The production archive stays unchanged. This
// injects a sealed mediaDevices shadow into fixed child bootstrap before model
// code, then tests synchronous fresh-realm recovery under the exact host CSP.
import { app, BrowserWindow, ipcMain, session, WebContentsView, webContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[process.argv.indexOf('--authority-evidence-dir') + 1];
const archive = process.env.APEX_AUTHORITY_PRODUCTION_ARCHIVE;
const { createGeneratedUIManager } = await import(pathToFileURL(path.join(archive, 'desktop/generated-ui/host.mjs')).href);
app.setPath('userData', path.join(root, 'privacy-diagnostic-profile'));
app.on('window-all-closed', () => {});
const evidence = { packaged: app.isPackaged, versions: { electron: process.versions.electron, chromium: process.versions.chrome }, syntheticOwner: true, productionHost: true, candidateBootstrapOnly: true, diagnostics: [], releaseAccepted: false };
const delayLifecycle = process.env.APEX_AUTHORITY_PRIVACY_DELAY === '1';
evidence.delayedLifecycleDiagnostic = delayLifecycle;
evidence.delayExplanation = delayLifecycle ? 'Delay frame/navigation host callbacks 120ms only to inspect native origin policy. This weakens teardown for diagnosis and cannot establish production behavior.' : 'Exact production lifecycle callbacks retained.';
const guard = 'Object.defineProperty(Navigator.prototype,"mediaDevices",{value:undefined,writable:false,configurable:false});Object.defineProperty(navigator,"mediaDevices",{value:undefined,writable:false,configurable:false});';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(10); } throw new Error('Privacy diagnostic timed out.'); }
let manager, win, renewing, current;
const events = [], audits = [];
const receive = (event, value) => manager?.receive(event, value);
ipcMain.on('generated-ui:message', receive);
void app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html,<title>Privacy diagnostic owner</title>');
    const owner = { win, frame: win.webContents.mainFrame }, bounds = { x: 20, y: 80, width: 700, height: 300 };
    renewing = setInterval(() => { if (current) manager.bounds(owner, current.runId, bounds); }, 100);
    const diagnosticSession = { fromPartition(...args) {
      const ses = session.fromPartition(...args), original = ses.protocol.handle.bind(ses.protocol);
      ses.protocol.handle = (scheme, handler) => original(scheme, async request => {
        const response = await handler(request);
        if (scheme !== 'https' || response.status !== 200) return response;
        const document = await response.text();
        const marker = 'const parentWindow = parent;';
        if (!document.includes(marker)) throw new Error('Trusted bootstrap marker not found.');
        const escaped = JSON.stringify(guard).slice(1, -1);
        return new Response(document.replace(marker, escaped + marker), { status: response.status, headers: response.headers });
      });
      return ses;
    } };
    class DiagnosticView extends WebContentsView {
      constructor(options) {
        super(options);
        if (!delayLifecycle) return;
        const page = this.webContents, on = page.on.bind(page);
        page.on = (event, listener) => on(event, ['frame-created','did-frame-navigate','did-start-navigation'].includes(event) ? (...args) => {
          if (page.mainFrame.framesInSubtree.length <= 2) return listener(...args);
          setTimeout(() => { if (!page.isDestroyed()) listener(...args); }, 120);
        } : listener);
      }
    }
    manager = createGeneratedUIManager({ electron: { app, session: diagnosticSession, webContents, WebContentsView: DiagnosticView }, testPolicy: { testOnly: true, enabled: true, ledger: { count: 0 } }, emit(_w, e) { events.push(e); }, audit(e) { audits.push(e); } });
    const cases = [
      { id: 'same-realm', code: `probe('navigator',()=>typeof navigator.mediaDevices);probe('prototype',()=>Object.getOwnPropertyDescriptor(Navigator.prototype,'mediaDevices'));probe('own',()=>Object.getOwnPropertyDescriptor(navigator,'mediaDevices'));probe('delete',()=>Reflect.deleteProperty(navigator,'mediaDevices'));probe('redefine',()=>Object.defineProperty(Navigator.prototype,'mediaDevices',{get(){return 'BYPASS'}}));probe('prototype-replace',()=>{Object.setPrototypeOf(navigator,{});return typeof navigator.mediaDevices});` },
      { id: 'iframe-default', code: `const f=document.createElement('iframe');document.body.append(f);probeRealm('default',f.contentWindow);` },
      { id: 'iframe-blank', code: `const f=document.createElement('iframe');f.src='about:blank';document.body.append(f);probeRealm('about-blank',f.contentWindow);` },
      { id: 'iframe-srcdoc', code: `const f=document.createElement('iframe');f.srcdoc='<p>fresh realm</p>';document.body.append(f);probeRealm('srcdoc-sync',f.contentWindow);` },
      { id: 'iframe-sandbox-scripts', code: `const f=document.createElement('iframe');f.sandbox='allow-scripts';f.src='about:blank';document.body.append(f);probeRealm('sandbox-scripts',f.contentWindow);` },
      { id: 'iframe-same-origin', code: `const f=document.createElement('iframe');f.sandbox='allow-scripts allow-same-origin';document.body.append(f);probeRealm('sandbox-same-origin',f.contentWindow);` },
      { id: 'iframe-detached', code: `const f=document.createElement('iframe');document.body.append(f);const realm=f.contentWindow;f.remove();probeRealm('detached',realm);` },
      { id: 'detached-document', code: `probe('createHTMLDocument',()=>{const d=document.implementation.createHTMLDocument('x');return {view:d.defaultView,navigator:typeof d.defaultView?.navigator}});probe('DOMParser',()=>{const d=new DOMParser().parseFromString('<html></html>','text/html');return {view:d.defaultView,navigator:typeof d.defaultView?.navigator}});` },
      { id: 'popup', code: `probe('window-open',()=>window.open('about:blank')===null);` },
      { id: 'document-open', code: `document.open();document.write('<html><body><p>Replaced document</p></body></html>');document.close();probe('after-document-open',()=>({mediaDevices:typeof navigator.mediaDevices,getter:typeof Object.getOwnPropertyDescriptor(Navigator.prototype,'mediaDevices')?.get}));` },
      { id: 'inert-elements', code: `probe('template',()=>{const t=document.createElement('template');t.innerHTML='<iframe></iframe>';document.body.append(t);return t.content.querySelector('iframe').contentWindow===null});probe('object',()=>{const o=document.createElement('object');o.data='about:blank';document.body.append(o);return {contentDocument:o.contentDocument===null}});probe('embed',()=>{const e=document.createElement('embed');e.src='about:blank';document.body.append(e);return {svgDocument:e.getSVGDocument()===null}});` },
      { id: 'native-brand', code: `probe('media-device-constructor',()=>new MediaDevices());probe('media-device-brand',()=>{const p=MediaDevices.prototype.enumerateDevices.call(Object.create(MediaDevices.prototype));p.then(ds=>{__privacy.brandRecovered=true;__privacy.brandDevices=ds.map(d=>({kind:d.kind,deviceId:d.deviceId,groupId:d.groupId,label:d.label}))}).catch(e=>__privacy.brandError={name:e.name,message:e.message});return 'promise-observed'});probe('navigator-constructor',()=>new Navigator());` },
    ];
    for (const fixture of cases) {
      const js = `window.__privacy={};const probe=(k,f)=>{try{__privacy[k]={value:f()}}catch(e){__privacy[k]={error:e.name,message:e.message}}};const probeRealm=(k,w)=>{probe(k,()=>{const n=w.navigator;const p=w.Navigator.prototype;const d=Object.getOwnPropertyDescriptor(p,'mediaDevices');const md=d?.get?d.get.call(n):n.mediaDevices;const result={secure:w.isSecureContext,navigator:typeof n,mediaDevices:typeof md,getter:typeof d?.get};if(md){__privacy.recovered=true;md.enumerateDevices().then(ds=>{__privacy.devices=ds.map(d=>({kind:d.kind,deviceId:d.deviceId,groupId:d.groupId,label:d.label}))}).catch(e=>__privacy.enumerationError=e.name)}return result})};${fixture.code}console.log('PRIVACY_SYNC:'+JSON.stringify(__privacy));setTimeout(()=>generatedUI.discuss(JSON.stringify(__privacy)),60);`;
      const card = { schemaVersion: 1, kind: 'generated', cardId: fixture.id, title: fixture.id, summary: 'Privacy candidate diagnostic', html: '<p>Diagnostic</p>', css: '', js, fallback: 'Diagnostic.' };
      let result, error;
      try {
        current = await manager.run(owner, { requestId: `${fixture.id}-request-0000000000001`, source: JSON.stringify(card), identity: { threadId: 'diagnostic', seq: 1, cardId: fixture.id, hostId: 'local' }, bounds });
        await until(() => events.find(row => row.runId === current.runId && ['discuss','stopped'].includes(row.type)));
        const discussion = events.find(row => row.runId === current.runId && row.type === 'discuss');
        if (discussion) result = JSON.parse(discussion.text);
      } catch (cause) { error = cause.message; }
      const runId = current?.runId || audits.filter(row => row.type === 'payload-delivered').at(-1)?.runId;
      const sync = audits.filter(row => row.runId === runId && row.type === 'renderer-console' && row.message.startsWith('PRIVACY_SYNC:')).map(row => row.message);
      if (current) await manager.stop(owner, current.runId);
      evidence.diagnostics.push({ fixture: fixture.id, result, sync, error, stopped: events.find(row => row.runId === runId && row.type === 'stopped'), disposal: audits.find(row => row.runId === runId && row.type === 'disposed') });
      current = null;
    }
    evidence.candidateBypassed = evidence.diagnostics.some(row => row.result?.recovered || row.result?.brandRecovered || row.sync.some(line => line.includes('"recovered":true')));
  } catch (error) { evidence.error = error.stack || String(error); }
  finally {
    clearInterval(renewing); await manager?.stopAll('Privacy diagnostic complete.'); win?.destroy(); ipcMain.removeListener('generated-ui:message', receive);
    fs.writeFileSync(path.join(root, 'privacy-diagnostic-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2)); app.exit(evidence.error ? 1 : 0);
  }
});
