// Synthetic trusted window, exact packaged host. Diagnostic only: determines
// whether proposed Blink feature switches actually suppress media enumeration.
import { app, BrowserWindow, ipcMain, session, WebContentsView, webContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[process.argv.indexOf('--authority-evidence-dir') + 1];
const archive = process.env.APEX_AUTHORITY_PRODUCTION_ARCHIVE;
const { createGeneratedUIManager } = await import(pathToFileURL(path.join(archive, 'desktop/generated-ui/host.mjs')).href);
app.setPath('userData', path.join(root, 'media-diagnostic-profile'));
app.on('window-all-closed', () => {});
const evidence = { packaged: app.isPackaged, versions: { electron: process.versions.electron, chromium: process.versions.chrome }, syntheticOwner: true, productionHost: true, diagnostics: [], releaseAccepted: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 6000; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); } throw new Error('Media diagnostic timed out.'); }
void app.whenReady().then(async () => {
  let manager, win, renewing, current; const events = [], audits = [];
  const receive = (event, value) => manager?.receive(event, value);
  ipcMain.on('generated-ui:message', receive);
  try {
    win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html,<title>Media diagnostic owner</title>');
    const owner = { win, frame: win.webContents.mainFrame }, bounds = { x: 20, y: 80, width: 700, height: 300 };
    renewing = setInterval(() => { if (current) manager.bounds(owner, current.runId, bounds); }, 100);
    for (const flag of ['', 'MediaDevices', 'MediaCapture']) {
      class DiagnosticView extends WebContentsView {
        constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, disableBlinkFeatures: [options.webPreferences.disableBlinkFeatures, flag].filter(Boolean).join(',') } }); }
      }
      manager = createGeneratedUIManager({ electron: { app, session, webContents, WebContentsView: DiagnosticView }, testPolicy: { testOnly: true, enabled: true, ledger: { count: 0 } }, emit(_w, e) { events.push(e); }, audit(e) { audits.push(e); } });
      const id = flag.toLowerCase() || 'default';
      const card = { schemaVersion: 1, kind: 'generated', cardId: id, title: id, summary: 'Media feature diagnostic', html: '<p>Diagnostic</p>', css: '', js: `setTimeout(async()=>{const r={mediaDevices:typeof navigator.mediaDevices};try{r.devices=(await navigator.mediaDevices.enumerateDevices()).map(d=>({kind:d.kind,deviceId:d.deviceId,groupId:d.groupId,label:d.label}));}catch(e){r.error={name:e.name,message:e.message}}generatedUI.discuss(JSON.stringify(r));},50);`, fallback: 'Diagnostic.' };
      current = await manager.run(owner, { requestId: `${id}-request-0000000000001`, source: JSON.stringify(card), identity: { threadId: 'diagnostic', seq: 1, cardId: id, hostId: 'local' }, bounds });
      const report = await until(() => events.find(row => row.runId === current.runId && row.type === 'discuss'));
      const result = JSON.parse(report.text);
      await manager.stop(owner, current.runId);
      evidence.diagnostics.push({ feature: flag || '(no additional switch)', result, disposal: audits.find(row => row.runId === current.runId && row.type === 'disposed') });
      current = null;
    }
  } catch (error) { evidence.error = error.stack || String(error); }
  finally {
    clearInterval(renewing); await manager?.stopAll('Media diagnostic complete.');
    win?.destroy(); ipcMain.removeListener('generated-ui:message', receive);
    fs.writeFileSync(path.join(root, 'media-diagnostic-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2)); app.exit(evidence.error ? 1 : 0);
  }
});
