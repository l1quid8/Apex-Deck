import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

// Render only the production editor; no user-service messages or real clipboard.
const fixture = { name: 'rich-editor-fixture', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/src/App.tsx')) return;
  return `import React from 'react';
    import RichDraftEditor from './RichDraftEditor';
    export function App() {
      const [state,setState]=React.useState({doc:[[{kind:'thread',paneId:'a',hostId:'local'}]],caret:{line:0,offset:1},draftId:'one'});
      const [tick,setTick]=React.useState(0);
      const known=React.useRef(new Set(['f1']));
      Object.assign(window,{editorState:state,setEditorState:(value)=>setState(s=>({...s,...value})),failFile:()=>{known.current.clear();setTick(t=>t+1)},triggers:window.triggers||[],attached:window.attached||[],carets:window.carets||[],closeCount:window.closeCount||0});
      return <main className="rail" data-tick={tick}><RichDraftEditor {...state}
        onChange={(doc,caret)=>setState(s=>({...s,doc,caret}))}
        chip={t=>({label:t.kind==='thread'?'#Thread A':'Image1',title:'Chip',busy:t.kind==='file'})}
        names={{thread:()=> 'Thread A',file:()=>({label:'Image1',name:'photo.png'})}}
        known={{thread:id=>id==='a',file:id=>known.current.has(id)}}
        onAttachFiles={(files,at)=>window.attached.push({names:files.map(f=>f.name),at})}
        onTrigger={(kind,query,at)=>window.triggers.push({kind,query,width:at.width})}
        onTriggerClose={()=>window.closeCount++}
        onCaretChange={caret=>window.carets.push(caret)}/></main>;
    }`;
}};

test('rich editor handles atomic edits, filtered history, IME, clipboard and drag', { timeout: 120000 }, async () => {
  await withAppearanceApp('rich-draft-editor', String.raw`
    await until('!!document.querySelector(".rich-draft-editor")');
    const doc=()=>run('window.editorState.doc');
    const set=async(value)=>{await run('window.setEditorState('+JSON.stringify(value)+')');await frame();};
    const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame();};
    const type=async(text)=>{for(const char of text){win.webContents.sendInputEvent({type:'char',keyCode:char});}await frame();};
    const mods=[process.platform==='darwin'?'meta':'control'];
    assert.equal(await run('document.activeElement===document.querySelector(".rich-draft-editor")'),true,'editor focuses on mount');
    await type('hello');
    assert.equal((await doc())[0][1].text,'hello');
    for(let i=0;i<6;i++) await key('Backspace');
    assert.deepEqual(await doc(),[[]]);
    await key('z',mods);
    assert.deepEqual(await doc(),[[{kind:'thread',paneId:'a',hostId:'local'},{kind:'text',text:'hello'}]]);
    await key('z',[...mods,'shift']);assert.deepEqual(await doc(),[[]]);
    // Native DOM insertion during IME is read once, rather than replayed.
    await set({draftId:'native-composition',doc:[[{kind:'thread',paneId:'a',hostId:'local'}]],caret:{line:0,offset:1}});
    await run('(()=>{const e=document.querySelector(".rich-draft-editor");e.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));e.firstChild.append(document.createTextNode("é"));e.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertCompositionText",data:"é",bubbles:true}));e.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"é"}));})()');await frame();
    assert.deepEqual(await doc(),[[{kind:'thread',paneId:'a',hostId:'local'},{kind:'text',text:'é'}]]);
    await set({draftId:'lines',doc:[[{kind:'thread',paneId:'a',hostId:'local'},{kind:'text',text:'one'}],[{kind:'text',text:'two'}]],caret:{line:0,offset:1}});
    await key('Delete');assert.equal((await doc())[0][1].text,'ne');
    await set({caret:{line:1,offset:0}});await key('Backspace');
    assert.deepEqual(await doc(),[[{kind:'thread',paneId:'a',hostId:'local'},{kind:'text',text:'netwo'}]]);
    await run('(()=>{const e=document.querySelector(".rich-draft-editor"),r=document.createRange();r.setStart(e.firstChild.firstChild,0);r.setEnd(e.firstChild.lastChild,2);const s=getSelection();s.removeAllRanges();s.addRange(r);})()');
    await set({}); // A metadata render must retain the person's selected range.
    await run('(()=>{const e=document.querySelector(".rich-draft-editor"),data=new DataTransfer();e.dispatchEvent(new ClipboardEvent("cut",{bubbles:true,cancelable:true,clipboardData:data}));window.cutText=data.getData("text/plain");})()');await frame();
    assert.equal(await run('window.cutText'),'#Thread Ane');
    assert.deepEqual(await doc(),[[{kind:'text',text:'two'}]]);
    await key('z',mods);assert.equal((await doc())[0][0].kind,'thread');
    assert.equal(await run('(()=>{const e=new InputEvent("beforeinput",{inputType:"historyRedo",bubbles:true,cancelable:true});document.querySelector(".rich-draft-editor").dispatchEvent(e);return e.defaultPrevented;})()'),true);
    await frame();assert.deepEqual(await doc(),[[{kind:'text',text:'two'}]]);
    await run('(()=>{const data=new DataTransfer();data.setData("text/plain","Image1");data.setData("application/x-apex-deck-draft+json",JSON.stringify({version:1,draftId:"other-draft",doc:[[{kind:"file",fileId:"f1"}]]}));document.querySelector(".rich-draft-editor").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data}));})()');await frame();
    assert.equal((await doc()).flat().some(t=>t.kind==='file'),false);
    await set({doc:[[{kind:'file',fileId:'f1'},{kind:'text',text:'one two'}]],caret:{line:0,offset:1}});
    await run('(()=>{const e=document.querySelector(".rich-draft-editor"),c=e.querySelector("[data-token]"),data=new DataTransfer();c.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:data}));const range=document.createRange();range.setStart(e.firstChild.lastChild,4);range.collapse(true);const rect=range.getBoundingClientRect();e.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,altKey:true,dataTransfer:data,clientX:rect.x,clientY:rect.y+rect.height/2}));})()');await frame();
    assert.deepEqual(await doc(),[[{kind:'file',fileId:'f1'},{kind:'text',text:'one '},{kind:'file',fileId:'f1'},{kind:'text',text:'two'}]]);
    await set({draftId:'files',doc:[[]],caret:{line:0,offset:0}});
    // Insert via the actual same-draft clipboard path, then type and remove.
    await run('window.paste=(plain,json)=>{const data=new DataTransfer();data.setData("text/plain",plain);if(json)data.setData("application/x-apex-deck-draft+json",json);document.querySelector(".rich-draft-editor").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data}));};window.paste("Image1",JSON.stringify({version:1,draftId:"files",doc:[[{kind:"file",fileId:"f1"}]]}))');
    await frame();assert.equal(await run('document.querySelector("[data-token]").getAttribute("aria-busy")'),'true');
    await type('x');await key('Left');await key('Backspace');
    assert.deepEqual(await doc(),[[{kind:'text',text:'x'}]]);
    await run('window.failFile()');await frame();await key('z',mods);
    assert.deepEqual(await doc(),[[]],'history skips snapshots containing only the failed file');
    await key('z',[...mods,'shift']);
    assert.equal((await doc()).flat().some(t=>t.kind==='file'),false);
    const before=await doc();await set({draftId:'new'});await key('z',mods);assert.deepEqual(await doc(),before);
    await set({doc:[[{kind:'thread',paneId:'a',hostId:'local'}]],caret:{line:0,offset:1}});
    await run('(()=>{const e=document.querySelector(".rich-draft-editor");window.composingChip=e.querySelector("[data-token]");e.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));e.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertCompositionText",data:"に",bubbles:true,cancelable:true}));})()');
    await set({caret:{line:0,offset:1}});
    assert.equal(await run('window.composingChip===document.querySelector("[data-token]")'),true,'no rewrite during composition');
    await run('document.querySelector(".rich-draft-editor").dispatchEvent(new CompositionEvent("compositionend",{data:"に",bubbles:true}))');await frame();
    assert.deepEqual(await doc(),[[{kind:'thread',paneId:'a',hostId:'local'},{kind:'text',text:'に'}]]);
    // Reload the isolated fixture to restore its known-file registry.
    await load();await until('!!document.querySelector(".rich-draft-editor")');
    await run('document.querySelector(".rich-draft-editor").focus()');
    await set({draftId:'copy',doc:[[{kind:'file',fileId:'f1'}],[]],caret:{line:0,offset:0}});
    await run('(()=>{const e=document.querySelector(".rich-draft-editor"),r=document.createRange();r.selectNodeContents(e.firstChild);const s=getSelection();s.removeAllRanges();s.addRange(r);const data=new DataTransfer();e.dispatchEvent(new ClipboardEvent("copy",{bubbles:true,cancelable:true,clipboardData:data}));window.copied={plain:data.getData("text/plain"),json:data.getData("application/x-apex-deck-draft+json")};})()');
    assert.equal(await run('window.copied.plain'),'[Image1: photo.png]');
    await set({caret:{line:1,offset:0}});
    await run('(()=>{const data=new DataTransfer();data.setData("text/plain",window.copied.plain);data.setData("application/x-apex-deck-draft+json",window.copied.json);document.querySelector(".rich-draft-editor").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data}));})()');await frame();
    assert.equal((await doc()).flat().filter(t=>t.kind==='file').length,2);
    await run('(()=>{const data=new DataTransfer();data.setData("text/plain","Image1");document.querySelector(".rich-draft-editor").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data}));})()');await frame();
    assert.equal((await doc())[1][1].text,'Image1');
    await set({doc:[[{kind:'file',fileId:'f1'},{kind:'text',text:'one two'}]],caret:{line:0,offset:1}});
    await run('(()=>{const e=document.querySelector(".rich-draft-editor"),c=e.querySelector("[data-token]"),data=new DataTransfer();c.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:data}));const range=document.createRange();range.setStart(e.firstChild.lastChild,4);range.collapse(true);const rect=range.getBoundingClientRect();e.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:data,clientX:rect.x,clientY:rect.y+rect.height/2}));})()');await frame();
    assert.deepEqual(await doc(),[[{kind:'text',text:'one '},{kind:'file',fileId:'f1'},{kind:'text',text:'two'}]]);
    await set({doc:[[]],caret:{line:0,offset:0}});await type('#Thread');
    assert.deepEqual(await run('window.triggers.at(-1).query'),'Thread');
    await set({doc:[[]],caret:{line:0,offset:0}});await type('@Null');
    assert.equal(await run('window.triggers.at(-1).kind'),'@');
    await key('Left');assert.deepEqual(await run('window.carets.at(-1)'),{line:0,offset:4});
    const closed=await run('window.closeCount');await key('Home');
    assert.equal(await run('window.closeCount>0'),true);
    assert.ok(await run('window.closeCount')>closed,'moving away from a trigger closes its menu');
    await set({caret:{line:0,offset:5}});
    await run('(()=>{const data=new DataTransfer();data.items.add(new File(["fake"],"picture.png",{type:"image/png"}));document.querySelector(".rich-draft-editor").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data}));})()');
    assert.deepEqual(await run('window.attached.at(-1).names'),['picture.png']);
    // External menu/file insertion participates in editor history too.
    await set({draftId:'external',doc:[[]],caret:{line:0,offset:0}});
    await set({doc:[[{kind:'thread',paneId:'a',hostId:'local'}]],caret:{line:0,offset:1}});
    await key('z',mods);assert.deepEqual(await doc(),[[]]);
    await key('z',[...mods,'shift']);assert.equal((await doc())[0][0].kind,'thread');
    // A send/reset during composition must never restore the previous draft.
    await run('document.querySelector(".rich-draft-editor").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}))');
    await set({draftId:'sent',doc:[[]],caret:{line:0,offset:0}});
    await run('document.querySelector(".rich-draft-editor").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"old"}))');await frame();
    assert.deepEqual(await doc(),[[]]);
  `, { plugins: [fixture], width: 900, height: 600 });
});
