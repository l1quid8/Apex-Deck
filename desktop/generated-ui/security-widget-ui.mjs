// Real React card + trusted IPC in a standalone test window; no production daemon.
import {app,BrowserWindow,ipcMain,powerMonitor,session,WebContentsView,webContents} from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {installGeneratedUI} from './host.mjs';
const root=process.argv[process.argv.indexOf('--fixture-dir')+1];
const phase=process.argv[process.argv.indexOf('--phase')+1]||'initial';
if(!root?.startsWith('/tmp/deck-widget-ui-'))throw Error('An isolated fixture folder is required');
app.setPath('userData',path.join(root,'profile'));
const evidence={versions:process.versions,pid:process.pid,phase,checks:[],passed:false,scope:'Real GeneratedAnswerCard, trusted generated UI IPC and sandbox; test page instead of full Deck/daemon'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function probe(){let win,manager;
 const until=async fn=>{const end=Date.now()+12000;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch{}await sleep(40);}throw Error('Widget UI timed out');};
 try{
 win=new BrowserWindow({width:1000,height:800,webPreferences:{preload:path.resolve('desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 win.setAlwaysOnTop(true);
 win.webContents.on('console-message',details=>console.log('fixture console:',details.message));
 ipcMain.on('apex:tauriStorage',event=>{event.returnValue={};});ipcMain.on('apex:smoke',event=>{event.returnValue=false;});
 manager=installGeneratedUI({electron:{app,ipcMain,powerMonitor,session,WebContentsView,webContents},deckWindow:event=>event.sender===win.webContents?{win}:null});
 const page=js=>win.webContents.executeJavaScript(js);
 await win.loadFile(path.join(root,'index.html'));app.focus({steal:true});win.show();win.focus();
 const generated=()=>webContents.getAllWebContents().filter(w=>!w.isDestroyed()&&w.getURL().startsWith('https://generated-ui.invalid/'));
 const start=async()=>{app.focus({steal:true});win.show();win.focus();await until(()=>win.isFocused());await sleep(300);const host=await until(async()=>{const host=generated().at(-1);return host&&await page('document.querySelector(".generated-slot")?.getAttribute("aria-busy")==="false"')?host:null;});return host.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');};
 const child=await start();
 assert.equal(await page('Boolean(document.querySelector(".generated-fallback"))'),false);
 if(phase==='restart'){
   const initial=JSON.parse(fs.readFileSync(path.join(root,'initial.json'),'utf8'));
   assert.notEqual(process.pid,initial.pid);
   assert.equal(await child.executeJavaScript('document.querySelector("#step").textContent'),'Stage 1');
   evidence.checks.push({name:'new app process restores Stage 1 from the same on-disk profile',passed:true});
   assert.equal(await page('Boolean(document.querySelector(".generated-snapshot"))'),true);
   evidence.checks.push({name:'app restart restores cached pixels with no fallback element',passed:true});
   evidence.passed=true;return;
 }
 await until(()=>page('Boolean(document.querySelector(".generated-snapshot"))'));
 // Do not wait for the setter's coalesced IPC: scroll/cover may overtake it.
 await child.executeJavaScript('document.querySelector("#next").click()');
 await page('const cover=document.createElement("div");cover.id="cover";cover.setAttribute("role","dialog");cover.style.cssText="position:fixed;inset:0;background:transparent";document.body.append(cover)');
 await until(()=>generated().length===0);
 assert.equal(await page('Boolean(document.querySelector(".generated-snapshot"))&&!document.querySelector(".generated-fallback")'),true);
 await page('document.querySelector(".generated-snapshot").decode()');
 fs.writeFileSync(path.join(root,'covered-cache.png'),(await win.webContents.capturePage()).toPNG());
 await page('document.querySelector("#cover").remove()');
 let reopened=await start();assert.equal(await reopened.executeJavaScript('document.querySelector("#step").textContent'),'Stage 1');
 evidence.checks.push({name:'cover/remount uses cached PNG without fallback and preserves immediate pre-cover selection',passed:true});
 await page('document.querySelector("#chat").scrollTop=700');await until(()=>generated().length===0);
 assert.equal(await page('Boolean(document.querySelector(".generated-snapshot"))&&!document.querySelector(".generated-fallback")'),true);
 await page('document.querySelector("#chat").scrollTop=0');reopened=await start();assert.equal(await reopened.executeJavaScript('document.querySelector("#step").textContent'),'Stage 1');
 evidence.checks.push({name:'real scroll-out disposes sandbox and scroll-in restores its state without fallback',passed:true});
 evidence.beforeReloadContinuity=await page('window.__widgetContinuity');
 assert.equal(evidence.beforeReloadContinuity.fallbackFrames,0);
 win.webContents.reload();await sleep(100);reopened=await start();assert.equal(await reopened.executeJavaScript('document.querySelector("#step").textContent'),'Stage 1');
 evidence.checks.push({name:'renderer reload restores state and cached pixels through trusted IPC',passed:true});
 await page('document.querySelector("#chat").scrollTop=700');await until(()=>generated().length===0);
 fs.writeFileSync(path.join(root,'cached.png'),(await win.webContents.capturePage()).toPNG());
 evidence.passed=true;
 }catch(error){evidence.error=error.stack||String(error);}finally{
   if(win&&!win.isDestroyed()){
     evidence.continuity=await win.webContents.executeJavaScript('window.__widgetContinuity').catch(()=>null);
     if(!evidence.continuity||evidence.continuity.fallbackFrames!==0){evidence.passed=false;evidence.error??='Visible fallback detected or continuity observer unavailable';}
   }
   await manager?.stopAll('UI test complete');win?.destroy();fs.writeFileSync(path.join(root,`${phase}.json`),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));app.exit(evidence.passed?0:1);
 }
}
void app.whenReady().then(probe);
