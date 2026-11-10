import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

for (const width of [1100, 1920]) test(`modified pane selection keeps a visible full-width input at ${width}px`, {timeout:120000}, async () => {
  await withAppearanceApp('multi-visible', String.raw`
    const panes=['a','b'].map(id=>({id,workspaceId:'w',kind:'chat',title:'Thread '+id,sample:true}));
    const session={version:1,workspaces:[{id:'w',name:'Sample',path:''}],panes,profiles:[],profileRevision:0,activeWorkspace:'w',focusedPane:'a',section:'threads',arrangements:{':threads':{mode:'grid',order:['a','b'],zoom:0,focusShare:.58}},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
    await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
    await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');
    await load(); await until('!!document.querySelector(".composer-dock textarea")');
    for (const id of ['a','b']) {
      await run('document.querySelector("[data-pane-id='+id+'] .pane-head").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,metaKey:true,ctrlKey:true}))');
      await until('!!document.querySelector(".rich-draft-editor")'); await frame();
      const geometry=await run('(()=>{const e=document.querySelector(".rich-draft-editor"), c=e.closest(".multi-composer"), box=c.querySelector(".composer-box"), send=box.querySelector(".round-send"); const r=e.getBoundingClientRect(), br=box.getBoundingClientRect(), sr=send.getBoundingClientRect();return {editor:{width:r.width,bottom:r.bottom},box:{width:br.width},sendTop:sr.top,background:getComputedStyle(box).backgroundColor}})()');
      assert.ok(geometry.editor.width>=geometry.box.width-24,'editor fills the composer box: '+JSON.stringify(geometry));
      assert.ok(geometry.editor.bottom<=geometry.sendTop,'the buttons follow the editor');
      assert.notEqual(geometry.background,'rgba(0, 0, 0, 0)','input has a visible surface');
      await run('document.querySelector(".rich-draft-editor").focus()');
      win.webContents.insertText(' Visible typing'); await frame();
      assert.ok(await run('document.querySelector(".rich-draft-editor").textContent.includes("Visible typing")'));
      await shot('multi-visible-'+panes.length+'-'+id);
    }
  `,{width,height:945});
});
