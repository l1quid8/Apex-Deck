import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { createServer } from "vite";
import { runElectronScenario } from "./helpers/electron-test.mjs";
import { RUN_MARKER, shellLine } from "../src/codeRun.ts";
import { NO_RUNS, codeRunsReducer, runPtyId } from "../src/useCodeRuns.ts";

const start = (key = "7:2", ptyId = "run:t:7:2:1", command = "echo hi") => ({ type: "start", key, ptyId, command });
const output = (ptyId, chunk) => ({ type: "output", ptyId, chunk });
const exit = (ptyId, code) => ({ type: "exit", ptyId, code });

test("a run starts empty and running, with the command it will show", () => {
  const runs = codeRunsReducer(NO_RUNS, start());
  assert.deepEqual(Object.keys(runs), ["7:2"]);
  assert.equal(runs["7:2"].ptyId, "run:t:7:2:1");
  assert.equal(runs["7:2"].command, "echo hi");
  assert.equal(runs["7:2"].state, "running");
  assert.equal(runs["7:2"].code, null);
  assert.equal(runs["7:2"].out.output, "");
  assert.equal(runs["7:2"].out.started, false);
});

test("PTY ids name the thread, the block and the click", () => {
  assert.equal(runPtyId("room-a", "3:1", 4), "run:room-a:3:1:4");
  assert.notEqual(runPtyId("room-a", "3:1", 4), runPtyId("room-a", "3:1", 5));
});

test("output before the marker is the shell's own noise and is dropped", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, output("run:t:7:2:1", "Last login: Mon Oct 19\r\n$ printf '\\033]777;apex-run\\007'"));
  assert.equal(runs["7:2"].out.output, "", "nothing shows before the marker");
  assert.equal(runs["7:2"].out.started, false);
  runs = codeRunsReducer(runs, output("run:t:7:2:1", `${RUN_MARKER}hi\r\n`));
  assert.equal(runs["7:2"].out.started, true);
  assert.equal(runs["7:2"].out.output, "hi\n", "the marker itself never shows");
});

test("a marker split across two chunks still starts the box", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, output("run:t:7:2:1", "rc noise"));
  runs = codeRunsReducer(runs, output("run:t:7:2:1", RUN_MARKER.slice(0, 6)));
  assert.equal(runs["7:2"].out.started, false);
  runs = codeRunsReducer(runs, output("run:t:7:2:1", `${RUN_MARKER.slice(6)}hello\n`));
  assert.equal(runs["7:2"].out.started, true);
  assert.equal(runs["7:2"].out.output, "hello\n");
});

test("escape codes are stripped and a lone carriage return rewinds the line", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, output("run:t:7:2:1", `${RUN_MARKER}\x1b[1;32mdone\x1b[0m\n`));
  runs = codeRunsReducer(runs, output("run:t:7:2:1", "50%\r100%\n"));
  assert.equal(runs["7:2"].out.output, "done\n100%\n");
});

test("an escape split across chunks is held until it is whole", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, output("run:t:7:2:1", `${RUN_MARKER}red \x1b[31`));
  assert.equal(runs["7:2"].out.output, "red ");
  runs = codeRunsReducer(runs, output("run:t:7:2:1", "mtext\x1b[0m\n"));
  assert.equal(runs["7:2"].out.output, "red text\n");
});

test("output for a PTY that is not in the runs changes nothing", () => {
  const runs = codeRunsReducer(NO_RUNS, start());
  assert.equal(codeRunsReducer(runs, output("run:t:7:2:9", `${RUN_MARKER}stray\n`)), runs, "identity kept");
  assert.equal(codeRunsReducer(runs, exit("someone-else", 0)), runs);
  assert.equal(codeRunsReducer(runs, { type: "fail", ptyId: "x", message: "no" }), runs);
});

test("a run that was replaced ignores its old shell", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, start("7:2", "run:t:7:2:2"));
  runs = codeRunsReducer(runs, output("run:t:7:2:1", `${RUN_MARKER}old\n`));
  assert.equal(runs["7:2"].out.output, "", "the box shows the new run only");
  assert.equal(runs["7:2"].ptyId, "run:t:7:2:2");
  runs = codeRunsReducer(runs, output("run:t:7:2:2", `${RUN_MARKER}new\n`));
  assert.equal(runs["7:2"].out.output, "new\n");
});

test("the exit code is kept once, and a second exit changes nothing", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, exit("run:t:7:2:1", 1));
  assert.equal(runs["7:2"].state, "exited");
  assert.equal(runs["7:2"].code, 1);
  const once = runs;
  assert.equal(codeRunsReducer(runs, exit("run:t:7:2:1", 0)), once);
});

test("the last chunk after an exit is still shown", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, output("run:t:7:2:1", `${RUN_MARKER}half`));
  runs = codeRunsReducer(runs, exit("run:t:7:2:1", 0));
  runs = codeRunsReducer(runs, output("run:t:7:2:1", " done\n"));
  assert.equal(runs["7:2"].out.output, "half done\n");
  assert.equal(runs["7:2"].state, "exited");
});

test("a shell that could not start says why, and its box stays empty", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, { type: "fail", ptyId: "run:t:7:2:1", message: "no shell here" });
  assert.equal(runs["7:2"].state, "error");
  assert.equal(runs["7:2"].error, "no shell here");
  assert.equal(runs["7:2"].code, null);
  const failed = runs;
  assert.equal(codeRunsReducer(runs, output("run:t:7:2:1", `${RUN_MARKER}late\n`)), failed, "no output for a failed start");
  assert.equal(codeRunsReducer(runs, exit("run:t:7:2:1", 0)), failed);
});

test("dismiss takes one box away, clear takes them all", () => {
  let runs = codeRunsReducer(NO_RUNS, start("7:2"));
  runs = codeRunsReducer(runs, start("7:3", "run:t:7:3:2"));
  runs = codeRunsReducer(runs, { type: "dismiss", key: "7:2" });
  assert.deepEqual(Object.keys(runs), ["7:3"]);
  assert.equal(codeRunsReducer(runs, { type: "dismiss", key: "7:2" }), runs, "a second dismiss changes nothing");
  assert.deepEqual(codeRunsReducer(runs, { type: "clear" }), {});
  assert.equal(codeRunsReducer(NO_RUNS, { type: "clear" }), NO_RUNS);
});

test("a long run keeps the tail of its output and says it was cut", () => {
  let runs = codeRunsReducer(NO_RUNS, start());
  runs = codeRunsReducer(runs, output("run:t:7:2:1", `${RUN_MARKER}${"a".repeat(40000)}`));
  runs = codeRunsReducer(runs, output("run:t:7:2:1", "b".repeat(40000)));
  assert.equal(runs["7:2"].out.truncated, true);
  assert.equal(runs["7:2"].out.output.length, 65536);
  assert.ok(runs["7:2"].out.output.endsWith("b"), "the newest output is what is left");
});

// The hook itself, in a real Chromium page, against a backend that records
// what it is asked to do. This is where the PTY ids, the one typed line and
// the single event subscription are checked.
test("the hook spawns, streams, stops and cleans up its shells", { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-runs-hook-"));
  const html = `<html><body><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {useCodeRuns} from '/src/useCodeRuns.ts';
    const h=React.createElement; const root=createRoot(document.getElementById('test-root'));
    const made={spawns:[],writes:[],kills:[],data:[],exits:[],demo:false,failSpawn:false};
    const backend={
      get demo(){return made.demo;},
      onPtyData:async cb=>{made.data.push(cb);return ()=>{made.data=made.data.filter(f=>f!==cb);};},
      onPtyExit:async cb=>{made.exits.push(cb);return ()=>{made.exits=made.exits.filter(f=>f!==cb);};},
      ptySpawn:async o=>{made.spawns.push(o);if(made.failSpawn)throw Error('no pty for you');},
      ptyWrite:async (id,text)=>{made.writes.push({id,text});},
      ptyKill:async id=>{made.kills.push(id);},
    };
    function Harness(){
      const [scope,setScope]=React.useState('room-a');
      const controls=useCodeRuns(backend,scope);
      window.fixture.controls=controls; window.fixture.scope=setScope;
      return h('output',{id:'runs'},JSON.stringify(controls.runs));
    }
    window.fixture={
      made,mount(demo=false){made.demo=demo;root.render(h(Harness,{key:Math.random()}));},
      start(key,command){window.fixture.controls.run(key,command,'/work');},
      startIn(key,command,cwd){window.fixture.controls.run(key,command,cwd);},
      stop(){window.fixture.controls.stop('7:2');},
      dismiss(key='7:2'){window.fixture.controls.dismiss(key);},
      data(id,chunk){made.data.forEach(fn=>fn(id,chunk,0));},
      exit(id,code){made.exits.forEach(fn=>fn(id,code));},
      thread(next){window.fixture.scope(next);},
      state(){return {spawns:made.spawns,writes:made.writes,kills:made.kills,subs:made.data.length+':'+made.exits.length};},
    };
    window.fixture.mount();
    window.ready=true;
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, "vite-cache"), server: { port: 0 }, logLevel: "error", plugins: [{ name: "code-runs-hook-test", configureServer(server) { server.middlewares.use("/__code_runs_hook_test", async (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(await server.transformIndexHtml("/__code_runs_hook_test", html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__code_runs_hook_test`;
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true}});
      win.webContents.on('console-message',(_e,...args)=>console.log(...args));
      const run=code=>win.webContents.executeJavaScript(code);
      const wait=async code=>{for(let i=0;i<300;i++){if(await run(code)) return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+code+' '+await run('document.body.innerHTML'));};
      const made=()=>run('window.fixture.state()');
      const call=(name,...args)=>run('window.fixture.'+name+'('+args.map(a=>JSON.stringify(a)).join(',')+')');
      // The boxes, as plain data, so the strings are compared where they are readable.
      const boxes=async()=>JSON.parse(await run('JSON.stringify(Object.values(JSON.parse(document.querySelector("#runs").textContent)))'));
      const box=async()=>(await boxes())[0]||null;
      const line=${JSON.stringify(shellLine("echo hi"))};
      const MARK=${JSON.stringify(RUN_MARKER)};
      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait('window.ready && document.querySelector("#runs")');

        // One subscription each, made once for the whole pane.
        assert.equal((await made()).subs,'1:1','one data and one exit subscription');
        assert.deepEqual(await boxes(),[],'no boxes before a run');

        // A run spawns in the thread's folder, then types the one marker line.
        await call('start','7:2','echo hi');
        await wait('Object.keys(JSON.parse(document.querySelector("#runs").textContent)).length===1');
        const first=await box();
        assert.match(first.ptyId,/^run:room-a:7:2:\\d+$/,'the id names the thread, the block and the click');
        assert.equal(first.state,'running');
        assert.equal(first.command,'echo hi');
        assert.equal(first.out.output,'');
        const spawned=await made();
        assert.deepEqual(spawned.spawns,[{id:first.ptyId,cwd:'/work',cols:120,rows:24}],'one spawn, in the thread\\'s folder');
        assert.deepEqual(spawned.writes,[{id:first.ptyId,text:line}],'the marker line is typed once');

        // Noise before the marker is the shell's own; what comes after it shows.
        await call('data',first.ptyId,'Last login: Mon Oct 19\\r\\n$ printf ' + JSON.stringify("'\\\\033]777;apex-run\\\\007'"));
        await new Promise(r=>setTimeout(r,60));
        assert.equal((await box()).out.output,'','the shell noise never shows');
        await call('data',first.ptyId,MARK+'hi\\r\\n');
        await wait('Object.values(JSON.parse(document.querySelector("#runs").textContent))[0].out.output.length>0');
        assert.equal((await box()).out.output,'hi\\n','the marker is dropped and \\\\r\\\\n becomes \\\\n');
        assert.equal((await box()).out.started,true);

        // Another pane's PTY is none of the box's business.
        await call('data','terminal-1',MARK+'stray\\n');
        await call('exit','terminal-1',0);
        await new Promise(r=>setTimeout(r,60));
        assert.equal((await box()).out.output,'hi\\n','another PTY changes nothing');
        assert.equal((await box()).state,'running','and cannot end the run either');

        // The shell's own code is what the box shows.
        await call('exit',first.ptyId,0);
        await wait('Object.values(JSON.parse(document.querySelector("#runs").textContent))[0].state==="exited"');
        assert.equal((await box()).code,0,'exit 0 is kept');

        // A finished run is replaced without killing anything; its box starts blank.
        await call('start','7:2','echo again');
        await wait('(Object.values(JSON.parse(document.querySelector("#runs").textContent))[0]||{}).command==="echo again"');
        const replaced=await box();
        assert.notEqual(replaced.ptyId,first.ptyId,'a new run gets a new id');
        assert.equal(replaced.out.output,'','the box starts blank');
        assert.equal((await made()).kills.length,0,'nothing was killed for the run that had already ended');

        // Running it again while it is still going does kill the old shell.
        await call('start','7:2','sleep 5');
        await wait('(Object.values(JSON.parse(document.querySelector("#runs").textContent))[0]||{}).command==="sleep 5"');
        const second=await box();
        assert.equal(second.state,'running');
        assert.equal(second.out.output,'');
        assert.ok((await made()).kills.includes(replaced.ptyId),'the shell it replaced was killed');

        // Stop kills the shell; the box waits for the shell to say it ended.
        await call('stop');
        await new Promise(r=>setTimeout(r,60));
        assert.equal((await box()).state,'running','the box waits for the exit event');
        assert.ok((await made()).kills.includes(second.ptyId),'stop killed the running shell');
        await call('exit',second.ptyId,null);
        await wait('Object.values(JSON.parse(document.querySelector("#runs").textContent))[0].state==="exited"');
        assert.equal((await box()).code,null,'a killed shell may report no code');

        // Dismiss takes the box away and kills nothing twice.
        const killsBefore=(await made()).kills.length;
        await call('dismiss');
        await wait('document.querySelector("#runs").textContent==="{}"');
        assert.equal((await made()).kills.length,killsBefore,'a finished run is not killed again');

        // A shell that cannot start says why instead of spinning.
        await run('window.fixture.made.failSpawn=true');
        await call('start','7:2','echo hi');
        await wait('(Object.values(JSON.parse(document.querySelector("#runs").textContent))[0]||{}).state==="error"');
        assert.equal((await box()).error,'no pty for you','the reason is shown');
        await run('window.fixture.made.failSpawn=false');
        await call('dismiss');
        await wait('document.querySelector("#runs").textContent==="{}"');

        // A thread with no folder passes no folder: "" is not a path, and the
        // daemon should pick the default the way TerminalPane does.
        const spawnsBefore=(await made()).spawns.length;
        await call('startIn','7:9','pwd','');
        await wait('Object.keys(JSON.parse(document.querySelector("#runs").textContent)).includes("7:9")');
        const homeless=await box();
        const spawns=(await made()).spawns;
        const noFolder=spawns[spawns.length-1];
        assert.equal(spawns.length,spawnsBefore+1,'the block still ran');
        assert.equal(noFolder.id,homeless.ptyId);
        assert.equal(noFolder.cwd,undefined,'an empty folder is not sent as an empty path');
        assert.equal(noFolder.cols,120,'and the size is unchanged');
        await call('dismiss','7:9');
        await wait('document.querySelector("#runs").textContent==="{}"');

        // Changing thread kills what is still going and clears the boxes.
        await call('start','7:2','sleep 5');
        await wait('(Object.values(JSON.parse(document.querySelector("#runs").textContent))[0]||{}).state==="running"');
        const running=(await box()).ptyId;
        const beforeSwap=(await made()).kills.length;
        await call('thread','room-b');
        await wait('document.querySelector("#runs").textContent==="{}"');
        const swapped=await made();
        assert.equal(swapped.kills.length,beforeSwap+1,'the old thread\\'s shell was killed');
        assert.equal(swapped.kills[swapped.kills.length-1],running,'and it is the one that was running');
        assert.equal(swapped.subs,'1:1','the subscription was not rebuilt per run');

        // The browser preview has no shell behind it, so the box says so.
        await run('window.fixture.mount(true)');
        await wait('document.querySelector("#runs")');
        const spawnedBefore=(await made()).spawns.length;
        await call('start','7:2','echo hi');
        await wait('(Object.values(JSON.parse(document.querySelector("#runs").textContent))[0]||{}).state==="error"');
        assert.match((await box()).error,/desktop app/,'the preview refuses plainly');
        assert.equal((await made()).spawns.length,spawnedBefore,'nothing was spawned in the preview');

        console.log('Code run hook checks passed'); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
