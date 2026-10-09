// usage: /Users/tylercaldwell/Downloads/apex-deck/node_modules/.bin/electron preview.cjs <htmlfile> <step-index|-1> <out.png> [js-to-run-after]
const {app,BrowserWindow}=require('electron');
const a=process.argv.slice(process.argv.findIndex(x=>x.endsWith('preview.cjs'))+1);const [file,step,out,js='']=a;
app.whenReady().then(async()=>{setTimeout(()=>{console.log('TIMEOUT');app.exit(2)},30000);const w=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{offscreen:true}});
 const errs=[];w.webContents.on('console-message',(e,l,m)=>{if(l>=2)errs.push(m)});
 await w.loadFile(file);w.webContents.setZoomFactor(0.7);await new Promise(r=>setTimeout(r,300));
 if(+step>=0)await w.webContents.executeJavaScript(`window.go&&go(${+step})`);
 if(js)await w.webContents.executeJavaScript(js);
 await new Promise(r=>setTimeout(r,700));const img=await w.webContents.capturePage();require('fs').writeFileSync(out,img.toPNG());
 if(errs.length)console.log('CONSOLE ERRORS:\n'+errs.join('\n'));console.log('saved',out);app.quit();});
