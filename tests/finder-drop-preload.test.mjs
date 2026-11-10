import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('only recent dropped paths can reach snapshot IPC, before subscribers run', async () => {
  let bridge, now=1000;const listeners=new Map(),calls=[];
  const ipc={on(){},removeListener(){},sendSync(){return false;},invoke:async(...args)=>{calls.push(args);return {kind:'file',name:'shot.png',bytes:new Uint8Array([7])};}};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),{
    require:()=>({contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:ipc,webFrame:{},webUtils:{getPathForFile:file=>file.diskPath||''}}),
    window:{addEventListener:(name,cb)=>listeners.set(name,cb)},localStorage:{getItem:()=>''},process:{platform:'darwin'},Date:class extends Date {static now(){return now;}},
  });
  const denied=/Only a file dropped on this window can be read/;
  assert.equal(typeof bridge.shell.snapshotDrop,'function','preload exposes the restricted snapshot method');
  await assert.rejects(bridge.shell.snapshotDrop('/etc/hosts'),denied);assert.equal(calls.length,0);
  const drop=files=>listeners.get('drop')({preventDefault(){},stopPropagation(){},dataTransfer:{files},clientX:35,clientY:45});
  drop([{name:'synthetic.png'}]);await assert.rejects(bridge.shell.snapshotDrop('/tmp/synthetic.png'),denied);
  let pending;bridge.shell.onFileDrop((paths,x,y)=>{assert.equal(x,35);assert.equal(y,45);pending=bridge.shell.snapshotDrop(paths[0]);});
  drop([{diskPath:'/tmp/shot.png'}]);await pending;
  assert.deepEqual(calls,[['shell:snapshotDrop','/tmp/shot.png']]);
  now+=60_001;await assert.rejects(bridge.shell.snapshotDrop('/tmp/shot.png'),denied);assert.equal(calls.length,1,'expired permission never invokes IPC');
  drop([{diskPath:'/tmp/shot.png'}]);await pending;assert.equal(calls.length,2,'dropping again renews permission');
});
