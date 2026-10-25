import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const binary = process.env.APEX_PHONE_BRIDGE_BIN;
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'duo-bridge-test-'));
  await fs.mkdir(path.join(dir, 'phone'));
  await fs.copyFile(binary, path.join(dir, 'bridge'));
  await fs.chmod(path.join(dir, 'bridge'), 0o755);
  const helper = path.join(dir, 'helper');
  await fs.writeFile(helper, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(dir,'ready'))},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(path.join(dir,'late'))},'late'),700);\n`, {mode:0o755});
  await fs.writeFile(path.join(dir,'deck-screen-bridge.json'), JSON.stringify({data:dir,udid:'INVALID',legacy:'/usr/bin/false',touch:helper,developer:'/unused'}));
  return dir;
}
test('cancelling bridge input terminates the native helper', {skip:!binary}, async () => {
  const dir = await fixture();
  try {
    const child = spawn(path.join(dir,'bridge'), ['key','42','--udid','INVALID'], {stdio:'ignore'});
    const exit = once(child,'exit');
    for (let i=0;i<100;i++) {
      if (await fs.access(path.join(dir,'ready')).then(()=>true,()=>false)) break;
      await new Promise(r=>setTimeout(r,20));
    }
    await fs.access(path.join(dir,'ready'));
    child.kill('SIGTERM'); await exit;
    await new Promise(r=>setTimeout(r,800));
    assert.equal(await fs.access(path.join(dir,'late')).then(()=>true,()=>false),false);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
for (const earlyExit of [false,true]) test(`unavailable capture revokes geometry and replaces stale video before exit (early exit: ${earlyExit})`, {skip:!binary,timeout:20000}, async () => {
  const dir = await fixture();
  try {
    const geometry = path.join(dir,'phone','bridge-frame.json');
    await fs.writeFile(geometry,'{"id":3}');
    const blocked = path.join(dir,'blocked');
    await fs.writeFile(blocked,'not a directory');
    const child = spawn(path.join(dir,'bridge'), ['stream-video','--udid','INVALID'], {stdio:['ignore','pipe','ignore'],env:earlyExit ? {...process.env,TMPDIR:blocked} : process.env});
    const chunks=[]; child.stdout.on('data',c=>chunks.push(c));
    const [code] = await once(child,'exit');
    assert.notEqual(code,0);
    assert.equal(await fs.access(geometry).then(()=>true,()=>false),false);
    const packet=Buffer.concat(chunks);
    assert.equal(packet.readUInt32BE(0),packet.length-4);
    assert.equal(packet.readUInt16BE(4),0xffd8);
    assert.equal(packet.readUInt16BE(packet.length-2),0xffd9);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
