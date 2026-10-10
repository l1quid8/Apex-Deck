const {app,BrowserWindow}=require('electron');
const fs=require('fs');
const path=require('path');
const root=__dirname;
app.setPath('userData',path.join(app.getPath('temp'),'apex-task-card-mockup-electron'));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 for(const device of ['mac','phone']){
 const win=new BrowserWindow({width:device==='mac'?1280:393,height:device==='mac'?860:852,show:false,useContentSize:true,webPreferences:{nodeIntegration:false,contextIsolation:true}});
 await win.loadFile(root+'/index.html',{query:{device}});
 await new Promise(r=>setTimeout(r,250));
 for(const state of ['approval','done']){
 if(state==='done')await win.webContents.executeJavaScript('approve()');
 const shot=await win.webContents.capturePage();fs.writeFileSync(root+'/screenshots/'+device+'-'+state+'.png',shot.toPNG());
 console.log(device+' '+state+' '+JSON.stringify(await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,cards:document.querySelectorAll(".task").length})')));
 }
 win.destroy();
 }
 app.quit();
});
