import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

const probe = { name: 'last-recipient-probe', enforce: 'pre', transform(code, id) {
  if (id.endsWith('/src/App.tsx')) return code.replace('const multiDraft = useMultiDraft();', 'const multiDraft = useMultiDraft(); (window as any).multiDraft = multiDraft;');
}};

test('deselecting the final recipient restores the single composer and Undo restores removed text', {timeout:120000}, async () => {
  await withAppearanceApp('last-recipient', String.raw`
    const panes=['a','b'].map(id=>({id,workspaceId:'w',kind:'chat',title:'Thread '+id,sample:true}));
    const session={version:1,workspaces:[{id:'w',name:'Sample',path:''}],panes,profiles:[],profileRevision:0,activeWorkspace:'w',focusedPane:'a',section:'threads',arrangements:{':threads':{mode:'grid',order:['a','b'],zoom:0,focusShare:.58}},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
    await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
    await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');
    await load(); await until('!!document.querySelector(".composer-dock textarea")');
    await run('window.multiDraft.setDoc([[{kind:"thread",paneId:"a",hostId:"local"},{kind:"text",text:"do not lose this"}]]);window.multiDraft.open()');
    await until('!!document.querySelector(".multi-composer")');
    await run('document.querySelector("[data-pane-id=a] .pane-head").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,metaKey:true,ctrlKey:true}))');
    await frame();
    assert.equal(await run('window.multiDraft.current().on'),false,'last deselection exits multi instead of stranding an empty composer');
    await until('!!document.querySelector(".composer-dock textarea")');
    assert.equal(await run('!!document.querySelector(".multi-composer")'),false);
    await run('[...document.querySelectorAll(".composer-dock .multi-kept button")].find(b=>b.textContent==="Undo").click()');
    await until('!!document.querySelector(".multi-composer")');
    assert.equal(await run('document.querySelector(".rich-draft-editor").textContent.includes("do not lose this")'),true);
    assert.deepEqual(await run('window.multiDraft.selected'),['a']);
    // Tag-only removal follows the same exit path, without a stranded zero-thread editor.
    await run('window.multiDraft.setDoc([[{kind:"thread",paneId:"a",hostId:"local"}]]);window.multiDraft.toggle("a","local")');
    await frame();
    assert.equal(await run('window.multiDraft.current().on'),false);
    await until('!!document.querySelector(".composer-dock textarea")');
  `,{width:1512,height:945,plugins:[probe]});
});
