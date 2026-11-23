import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { channel } from '../desktop/channel.mjs';
import * as provenance from '../desktop/provenance.mjs';
import { launchPlan, runLaunchPlan } from '../desktop/trustedInstall.mjs';
const linuxService=await import('../desktop/linuxService.mjs').catch(()=>({}));

const root = channel.LINUX_ROOT;
const descriptor = () => ({schema:1,epoch:7,phase:'ready',active:{tree:channel.LINUX_TREE + '/0.9.9-test-arm64',manifestSha256:'a'.repeat(64),protocol:1,epoch:7},pending:null});
function filesFor(state=descriptor()) {
  const nodes=new Map();
  for (const file of [`${root}/public-key`,`${root}/installation.json`]) {
    for(let at=path.posix.dirname(file);;at=path.posix.dirname(at)) {
      nodes.set(at,{uid:0,mode:0o755,kind:'directory'});if(at==='/')break;
    }
    nodes.set(file,{uid:0,mode:file.endsWith('installation.json')?0o600:0o644,kind:'file'});
  }
  const reads=[];
  return {nodes,reads,lstatSync(file){const node=nodes.get(file);if(!node)throw Object.assign(new Error('missing'),{code:'ENOENT'});return {...node,isSymbolicLink:()=>node.kind==='link',isDirectory:()=>node.kind==='directory',isFile:()=>node.kind==='file'};},readFileSync(file){reads.push(file);const node=nodes.get(file);if(!node)throw Object.assign(new Error('missing'),{code:'ENOENT'});if(node.mode===0o600)throw Object.assign(new Error('permission denied'),{code:'EACCES'});return file.endsWith('public-key')?Buffer.alloc(32,3):Buffer.from(JSON.stringify(state));}};
}
const plan = files => launchPlan({packaged:true,platform:'linux',bundle:'/tmp/app/resources/app.asar',version:'0.9.9',daemon:'/tmp/app/resources/bin/apex-daemon',files});

test('Linux desktop uses fixed Linux broker paths while Mac and Windows retain theirs',()=>{
  assert.equal(typeof provenance.authorityPaths,'function');
  assert.deepEqual(provenance.authorityPaths('linux'),{root,socket:channel.LINUX_SOCKET});
  assert.equal(provenance.authorityPaths('darwin').root,channel.MAC_ROOT);
  assert.equal(provenance.authorityPaths('win32').socket,channel.WINDOWS_PIPE);
});

test('Linux authority key refuses unsafe ancestors and substituted key file types',()=>{
  assert.equal(typeof provenance.protectedPublicKey,'function');
  assert.deepEqual(provenance.protectedPublicKey({platform:'linux',files:filesFor()}),Buffer.alloc(32,3));
  for(const [target,change] of [[root,{uid:501}],['/var/lib',{mode:0o777}],[`${root}/public-key`,{kind:'link'}],[`${root}/public-key`,{kind:'directory'}]]){
    const files=filesFor();Object.assign(files.nodes.get(target),change);
    assert.throws(()=>provenance.protectedPublicKey({platform:'linux',files}),/protected|root|regular/i);
  }
});

test('Linux installed files do not masquerade as authenticated UI launch proof',async()=>{
  const got=plan(filesFor());
  assert.equal(got.kind,'notice');
  assert.match(got.protectedSubmissionError,/launch attestation/i);
  assert.match(got.notice.detail,/same account/i);
  const events=[];
  assert.equal(await runLaunchPlan(got,{open:()=>assert.fail('no trusted launcher exists'),quit:()=>assert.fail('evaluation UI may open'),notice:value=>events.push(value)}),true);
  assert.equal(events.length,1);
  assert.equal(got.protectedInstallationDetected,true);
  assert.equal(got.daemon,'/tmp/app/resources/bin/apex-daemon','descriptor must never select an engine without authenticated enrolled-scope discovery');
});

test('Linux missing, incomplete and unsafe installations refuse protected UI routing',()=>{
  for(const state of [null,{...descriptor(),phase:'prepared'}, {...descriptor(),epoch:8}, {...descriptor(),active:{...descriptor().active,tree:'/tmp/copied-ui'}}, {...descriptor(),extra:true}]){
    const files=filesFor(state);if(state===null)files.nodes.delete(`${root}/installation.json`);
    const got=plan(files);assert.equal(got.kind,'notice');assert.match(got.protectedSubmissionError,/install|repair/i);assert.equal(got.app,undefined);
  }
  const files=filesFor();files.nodes.get(root).mode=0o777;
  assert.match(plan(files).protectedSubmissionError,/install|repair/i);
});

test('Linux data-directory overrides cannot turn a packaged evaluation UI into approval authority',()=>{
  const options={platform:'linux',bundle:'/tmp/app/resources/app.asar',daemon:'/tmp/app/resources/bin/apex-daemon',files:filesFor()};
  assert.match(launchPlan({...options,packaged:true,dataDir:'/tmp/isolated'}).protectedSubmissionError,/launch attestation/i);
  const development=launchPlan({...options,packaged:false,dataDir:'/tmp/isolated'});
  assert.equal(development.kind,'run');
  assert.equal(development.protectedSubmissionError,undefined);
});

test('root-only installation state cannot cause a portable daemon fallback',async()=>{
  assert.equal(typeof linuxService.linuxLocalDaemon,'function');
  const files=filesFor();
  assert.equal(files.nodes.get(`${root}/installation.json`).mode,0o600);
  assert.throws(()=>files.readFileSync(`${root}/installation.json`),{code:'EACCES'});
  files.reads.length=0;
  const selected=plan(files);
  let portableStarts=0;
  await assert.rejects(linuxService.linuxLocalDaemon({plan:selected,startPortable:()=>portableStarts++}),/enrolled|scope|data folder/i);
  assert.equal(portableStarts,0);
  assert.deepEqual(files.reads,[],'private authority records must not be read or made public for UI routing');
});

test('unknown or mismatched enrolled scope and pending activation never invoke an installed or portable engine',async()=>{
  assert.equal(typeof linuxService.linuxLocalDaemon,'function');
  for(const dataDir of [undefined,'/home/other-user/.apex-deck','/tmp/override']){
    for(const pending of [false,true]){
      const files=filesFor();
      files.nodes.get(`${root}/installation.json`).mode=0o644;
      if(pending)files.nodes.set(`${root}/installation.pending`,{uid:0,mode:0o600,kind:'file'});
      const selected=launchPlan({packaged:true,platform:'linux',dataDir,bundle:'/tmp/app/resources/app.asar',daemon:'/tmp/portable-daemon',files});
      assert.equal(selected.daemon,'/tmp/portable-daemon');
      await assert.rejects(linuxService.linuxLocalDaemon({plan:selected,startPortable:()=>assert.fail('protected installation must not start a portable engine')}),/enrolled|scope|data folder/i);
    }
  }
});

test('portable Linux evaluation keeps its engine only when no protected installation exists',async()=>{
  assert.equal(typeof linuxService.linuxLocalDaemon,'function');
  const files=filesFor();files.nodes.delete(root);
  const selected=plan(files);
  let starts=0;
  assert.equal(await linuxService.linuxLocalDaemon({plan:selected,startPortable:()=>{starts++;return 'portable';}}),'portable');
  assert.equal(starts,1);
});
