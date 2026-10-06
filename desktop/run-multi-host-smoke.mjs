// Two real daemon processes and the native renderer. The SSH executable is a
// fixture adapter, so this checks SSH-link isolation without claiming VPS proof.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { DaemonClient } from '../src/daemon/client.ts';
import { socketLink } from '../tests/e2e/link.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync('/tmp/adh-');
const mac = path.join(root, 'mac'); const remote = path.join(root, 'server');
const bin = path.resolve('target/debug/apex-daemon');
const children = new Set();
const out = path.resolve(process.env.APEX_DECK_SMOKE_OUTPUT || '.superpowers/smoke/multi-host');
fs.mkdirSync(out, { recursive: true });
async function daemon(data) {
  fs.mkdirSync(data, { recursive: true });
  const child = spawn(bin, ['serve', '--exit-on-stdin-close', '--data-dir', data], { stdio: ['pipe', 'ignore', 'pipe'] });
  children.add(child); let error=''; child.stderr.on('data', b => error += b);
  child.on('exit', () => children.delete(child));
  const end = Date.now() + 15000;
  while (!fs.existsSync(path.join(data,'daemon.sock'))) {
    if (child.exitCode !== null || Date.now() > end) throw Error(error || 'daemon startup timeout');
    await sleep(30);
  }
  return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  let timeout;
  try { await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => { timeout=setTimeout(r,12000); })]); }
  finally { clearTimeout(timeout); }
  if (child.exitCode === null) child.kill('SIGKILL');
}
const options = { policy: 'mention', max_bot_hops: 0 };
const bot = reply => ({ id:'bot',display_name:'Bot',backend:{kind:'cli',program:'sh',args:['-c',`echo ${reply}`]} });
async function seed(data, id, title, reply) {
  const client = new DaemonClient(() => socketLink(path.join(data,'daemon.sock')));
  try {
    await client.start();
    await client.call('room_create', {id,participants:[bot(reply)],options,cwd:root});
    const panes=[{id,workspaceId:'shared-workspace-id',kind:'chat',title,pinned:true}];
    if(id==='server-thread')panes.push({id:'server-terminal',workspaceId:'shared-workspace-id',kind:'terminal',title:'Server terminal',closed:true});
    await client.call('session_save', {session:{version:1,workspaces:[{id:'shared-workspace-id',name:title,path:root}],panes,profiles:[],activeWorkspace:'shared-workspace-id',focusedPane:id,section:'threads',layout:'left'}});
  } finally { client.close(); }
}
const q = text => `'${text.replaceAll("'", "'\\''")}'`;
let app; let restartWatch;
try {
  const localSeed = await daemon(mac); let server = await daemon(remote);
  await seed(mac,'mac-thread','Mac thread','mac-native-reply');
  await seed(remote,'server-thread','Server thread','server-native-reply');
  await stop(localSeed);
  let restarting=false;
  restartWatch=fs.watch(root,(_event,file)=>{
    if(file!=='restart'||restarting||!fs.existsSync(path.join(root,'restart')))return;
    restarting=true;
    void (async()=>{await stop(server);server=await daemon(remote);fs.writeFileSync(path.join(root,'restart-done'),'1');})().catch(error=>{console.error(error);app?.kill('SIGKILL');});
  });
  const desktop = mac + '-desktop'; const shim = path.join(root,'bin');
  fs.mkdirSync(desktop); fs.mkdirSync(shim);
  fs.writeFileSync(path.join(desktop,'hosts.json'),JSON.stringify({version:1,last:'at',windows:['at'],hosts:[{id:'at',name:'Production-Frankfurt-Primary-01',ssh:'fixture',command:bin}]}));
  // "other-fixture" reaches the Mac's daemon: a different machine, for Edit connection.
  fs.writeFileSync(path.join(shim,'ssh'),`#!/bin/sh\nif [ -f ${q(path.join(root,'offline'))} ]; then echo 'fixture offline' >&2; exit 1; fi\ncase "$*" in *other-fixture*) exec ${q(bin)} --stdio --attach --data-dir ${q(mac)} ;; esac\necho $$ > ${q(path.join(root,'attach.pid'))}\nexec ${q(bin)} --stdio --attach --data-dir ${q(remote)}\n`,{mode:0o755});
  app = spawn(electron,['.'], {stdio:'inherit',env:{...process.env,PATH:`${shim}:${process.env.PATH}`,APEX_DECK_SMOKE:'1',APEX_DECK_MULTI_HOST_ROOT:root,APEX_DECK_DATA_DIR:mac,APEX_DECK_SMOKE_OUTPUT:out}});
  const timer=setTimeout(()=>app.kill('SIGKILL'),120000);
  const code=await new Promise(resolve=>app.once('exit',resolve));clearTimeout(timer);
  if (code !== 0) throw Error(`native multi-host smoke exited ${code}`);
  // The SSH attach ending must leave the server daemon alive.
  if (server.exitCode !== null) throw Error('quitting Deck ended the remote daemon');
  console.log(`multi-host: ok — native fixture evidence saved in ${out}`);
} catch(error) { console.error(error.stack); process.exitCode=1; }
finally { restartWatch?.close(); app?.kill(); await Promise.all([...children].map(stop)); fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); fs.rmSync(mac+'-desktop',{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
