import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electron from 'electron';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('real Finder-style drop snapshots through production preload and rejects arbitrary paths', {timeout:45000}, async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'deck-finder-drop-'));
  const main=path.join(temp,'main.cjs'), file=path.join(temp,'shot.png');
  fs.writeFileSync(file,Buffer.from([0,1,2,250,255]));
  const source=fs.readFileSync(new URL('../desktop/main.mjs',import.meta.url),'utf8');
  const handler=source.match(/^handle\('shell:snapshotDrop'.*$/m)?.[0];
  assert.ok(handler,'production main registers the snapshot handler');
  fs.writeFileSync(main,`
    const {app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs');
    app.whenReady().then(async()=>{
      const {snapshotFile}=await import(${JSON.stringify(pathToFileURL(path.resolve('desktop/files.mjs')).href)});
      const SEND_LIMIT=20*1024*1024;
      const handle=(channel,fn)=>ipcMain.handle(channel,(_event,...args)=>fn(null,...args));
      ${handler}
      ipcMain.on('apex:tauriStorage',event=>{event.returnValue={};});ipcMain.on('apex:smoke',event=>{event.returnValue=false;});
      const win=new BrowserWindow({show:false,width:600,height:400,webPreferences:{preload:${JSON.stringify(path.resolve('desktop/preload.cjs'))},sandbox:true,contextIsolation:true,backgroundThrottling:false}});
      const run=code=>win.webContents.executeJavaScript(code);
      try {
        await win.loadURL('data:text/html,<html><body style="margin:0;width:100vw;height:100vh">Drop here</body></html>');
        assert.equal(await run('typeof window.apexDeck.shell.snapshotDrop'),'function');
        assert.match(await run('window.apexDeck.shell.snapshotDrop("/etc/hosts").then(()=>"READ",e=>e.message)'),/Only a file dropped on this window can be read/);
        await run('window.dropSnapshots=[];window.dropErrors=[];window.domDrops=0;window.addEventListener("drop",()=>window.domDrops++);window.apexDeck.shell.onFileDrop(async(paths,x,y)=>{try{const s=await window.apexDeck.shell.snapshotDrop(paths[0]);window.dropSnapshots.push({kind:s.kind,name:s.name,bytes:Array.from(s.bytes),x,y});}catch(e){window.dropErrors.push(e.message)}});true');
        // Synthetic Files have no disk path and must not grant access.
        await run('(()=>{const dt=new DataTransfer();dt.items.add(new File(["fake"],"shot.png"));document.body.dispatchEvent(new DragEvent("drop",{dataTransfer:dt,bubbles:true,cancelable:true}))})()');
        assert.equal(await run('window.dropSnapshots.length'),0);
        assert.match(await run('window.apexDeck.shell.snapshotDrop('+${JSON.stringify(JSON.stringify(file))}+').then(()=>"READ",e=>e.message)'),/Only a file dropped on this window can be read/);
        win.webContents.debugger.attach('1.3');
        const data={items:[],files:[${JSON.stringify(file)}],dragOperationsMask:1};
        for(const type of ['dragEnter','dragOver','drop'])await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type,x:120,y:140,data});
        for(let i=0;i<200&&await run('!window.dropSnapshots.length&&!window.dropErrors.length');i++)await new Promise(r=>setTimeout(r,10));
        const snapshots=await run('window.dropSnapshots');
        assert.equal(snapshots.length,1,'CDP must yield a real Finder path through webUtils: '+JSON.stringify(await run('({errors:window.dropErrors,dom:window.domDrops})')));
        assert.deepEqual(snapshots[0],{kind:'file',name:'shot.png',bytes:[0,1,2,250,255],x:120,y:140});
        fs.writeFileSync(${JSON.stringify(file)},'replaced');fs.unlinkSync(${JSON.stringify(file)});
        assert.deepEqual(await run('window.dropSnapshots[0].bytes'),[0,1,2,250,255],'later source changes cannot alter the captured bytes');
        assert.equal(await run('window.domDrops'),1,'only the synthetic drop reaches DOM handlers');
        console.log('Real Finder path snapshot and arbitrary/synthetic path rejection passed');
        win.destroy();app.exit(0);
      } catch(error){console.error(error.stack);win.destroy();app.exit(1);}
    });
  `);
  try {
    const result=await runElectronScenario(electron,main,temp,{timeoutMs:30000,attempts:1});
    assert.equal(result.code,0,result.output);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
