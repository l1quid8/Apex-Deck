const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
app.setPath('userData', path.join(app.getPath('temp'), 'null-apex-workspace-mockup'));
app.on('window-all-closed', () => {});
const cases = [
  ['conversation', {view:'chat'}],
  ['tasks', {view:'tasks'}],
  ['review-result', {view:'task', task:'mockup'}],
  ['approval', {view:'task', task:'cleanup'}],
  ['finished', {view:'tasks', filter:'finished'}],
  ['sources', {view:'sources'}],
  ['artifact', {view:'artifact'}],
];

app.whenReady().then(async () => {
  const records = [];
  fs.mkdirSync(path.join(root, 'screenshots'), {recursive:true});
  for (const device of ['mac', 'phone']) {
    const win = new BrowserWindow({
      width: device === 'mac' ? 1360 : 393,
      height: device === 'mac' ? 920 : 852,
      useContentSize:true, show:false,
      webPreferences:{nodeIntegration:false, contextIsolation:true, sandbox:true},
    });
    const errors = [];
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 3) errors.push(event.message);
    });
    for (const [name, query] of cases) {
      await win.loadFile(path.join(root, `${device}.html`), {query});
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const metrics = await win.webContents.executeJavaScript(`(() => {
        const visible = el => {const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'};
        const controls=[...document.querySelectorAll('button,input,select,textarea,a[href],summary')].filter(visible);
        return {width:innerWidth,height:innerHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
          headings:[...document.querySelectorAll('h1,h2,h3')].filter(visible).map(el=>el.textContent.trim()),
          controls:controls.map(el=>({label:el.getAttribute('aria-label')||el.textContent.trim()||el.getAttribute('placeholder'),
            width:Math.round(el.getBoundingClientRect().width),height:Math.round(el.getBoundingClientRect().height)})),
          state:typeof window.mockupInspect==='function'?window.mockupInspect():null};
      })()`);
      const file = `${device}-${name}.png`;
      fs.writeFileSync(path.join(root, 'screenshots', file), (await win.webContents.capturePage()).toPNG());
      records.push({device,name,file,query,metrics,errors:[...errors]});
      console.log(`${device}/${name}: ${metrics.width}x${metrics.height}, overflow=${metrics.horizontalOverflow}, errors=${errors.length}`);
    }
    if (device === 'phone') {
      win.setContentSize(375, 812);
      await win.loadFile(path.join(root, 'phone.html'), {query:{view:'tasks'}});
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const horizontalOverflow = await win.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth');
      const file='phone-narrow-tasks.png';
      fs.writeFileSync(path.join(root,'screenshots',file),(await win.webContents.capturePage()).toPNG());
      records.push({device,name:'narrow-tasks',file,query:{view:'tasks'},metrics:{width:375,height:812,horizontalOverflow},errors:[...errors]});
      console.log(`phone/narrow-tasks: 375x812, overflow=${horizontalOverflow}, errors=${errors.length}`);
    }
    win.destroy();
  }
  fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({kind:'design-only',capturedAt:new Date().toISOString(),records},null,2)+'\n');
  app.exit(records.some(r=>r.errors.length||r.metrics.horizontalOverflow)?1:0);
}).catch(error=>{console.error(error);app.exit(1)});
