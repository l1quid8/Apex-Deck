import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

// Inject only the host's folder-check reply; render the real App and use its
// real session save/load, project discovery, sidebar, and canvas paths.
const probe = {name:'work-folder-reply',enforce:'pre',transform(code,id) {
  if (!id.endsWith('/src/desktopChats.ts')) return;
  return code.replace('const [catalog, setCatalog] = useState<ChatCatalog>(emptyCatalog);',
    'const [catalog, setCatalog] = useState<ChatCatalog>(emptyCatalog); (window as any).setTestWorkCatalog = setCatalog;');
}};

test('desktop refresh and relaunch hide saved stale threads while session saves keep their history', {timeout:120000}, async () => {
  await withAppearanceApp('work-folder-presentation', String.raw`
    const workspaces=[{id:'gone',name:'Stale QA',path:'/missing-qa'},{id:'live',name:'Current project',path:'/live'}];
    const panes=[{id:'old',workspaceId:'gone',kind:'chat',title:'Stale thread',pinned:true,activeAt:5,sample:true},
      {id:'good',workspaceId:'live',kind:'chat',title:'Current thread',sample:true}];
    const session={version:1,workspaces,panes,profiles:[],profileRevision:0,activeWorkspace:'gone',focusedPane:'old',section:'threads',arrangements:{},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
    await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
    await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');
    const missing={hosts:{local:{name:'This Mac',listedAt:1,rooms:[
      {id:'old',hostId:'local',kind:'work',cwd:'/missing-qa',cwdAvailable:false,title:'Stale thread',bots:[],updatedAt:5,archived:false},
      {id:'good',hostId:'local',kind:'work',cwd:'/live',cwdAvailable:true,title:'Current thread',bots:[],updatedAt:1,archived:false},
    ]}}};
    const inject=async catalog=>{await run('window.setTestWorkCatalog('+JSON.stringify(catalog)+')');await frame();};
    for(let attempt=0;attempt<2;attempt++){
      await load();
      await until('!!document.querySelector(".ws-name[data-workspace=live]")');
      await inject(missing);
      assert.equal(await run('!!document.querySelector(".ws-name[data-workspace=gone]")'),false,'saved missing folder must leave the sidebar');
      assert.equal(await run('!!document.querySelector("[data-pane-id=old]")'),false,'stale thread must leave the canvas');
      assert.equal(await run('document.querySelector(".rail").textContent.includes("Stale thread")'),false,'pinned and recent rows must not resurrect it');
      await until('JSON.parse(localStorage.getItem("apex-deck.demo.session.v1")).activeWorkspace==="live"');
      const saved=await run('JSON.parse(localStorage.getItem("apex-deck.demo.session.v1"))');
      assert.deepEqual(saved.workspaces.map(w=>w.id),['gone','live'],'autosave must retain missing projects');
      assert.deepEqual(saved.panes.map(p=>p.id),['old','good'],'autosave must retain missing conversations');
    }
    const restored=JSON.parse(JSON.stringify(missing));restored.hosts.local.listedAt=2;restored.hosts.local.rooms[0].cwdAvailable=true;
    await inject(restored);
    await until('!!document.querySelector(".ws-name[data-workspace=gone]")');
    assert.equal(await run('document.querySelectorAll(".ws-name[data-workspace=gone]").length'),1,'restore uses the original workspace');
    assert.equal(await run('document.querySelector(".rail").textContent.includes("Stale thread")'),true,'restored folder retains the original conversation');
  `,{plugins:[probe],offscreen:true});
});
