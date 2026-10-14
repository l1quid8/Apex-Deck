// Reproducible packaged integration gate. Never modifies the source/installed app.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPackage, extractAll } from '@electron/asar';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.mkdtempSync(path.join('/tmp', 'deck-generated-lifecycle-'));
const sourceApp = path.resolve(process.argv[2] || path.join(repo, 'release/mac-arm64/Apex Deck.app'));
const targetApp = path.join(root, 'Apex Deck.app');
fs.cpSync(sourceApp, targetApp, { recursive: true, verbatimSymlinks: true });
const resources = path.join(targetApp, 'Contents/Resources');
const archive = path.join(resources, 'app.asar');
fs.copyFileSync(archive, path.join(resources,'app-production.asar'));
const source = path.join(root,'source');
extractAll(archive, source);
const sourceHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceCode = ['desktop/main.mjs','desktop/preload.cjs','desktop/generated-ui/host.mjs','desktop/generated-ui/frame-content.mjs','desktop/generated-ui/policy.mjs','desktop/generated-ui/preload.cjs','desktop/generated-ui/protocol.mjs','shared/generatedCard.mjs','shared/generatedUiCapability.mjs','shared/generated-ui-runtime.json','dist/index.html',...fs.readdirSync(path.join(repo,'dist/assets')).filter(file=>/\.(js|css)$/.test(file)).map(file=>'dist/assets/'+file)].map(file => ({ file, production: fs.existsSync(path.join(source,file)) ? sourceHash(path.join(source,file)) : null, checkout: sourceHash(path.join(repo,file)) }));
// Use current host/adapter/validator sources in the exact shipped runtime.
for (const directory of ['desktop/generated-ui','shared','dist']) fs.cpSync(path.join(repo,directory),path.join(source,directory),{recursive:true});
let main = fs.readFileSync(path.join(source,'desktop/main.mjs'),'utf8');
main = main.replace('installGeneratedUI({ electron:', 'const generatedUIManager = installGeneratedUI({ electron:');
main = main.replace("const { runSmoke } = env.APEX_DECK_ANSWERS_SMOKE ?", "const { runSmoke } = env.APEX_GENERATED_OUTPUT ? await import('./generated-ui/security-lifecycle.mjs') : env.APEX_DECK_ANSWERS_SMOKE ?");
main = main.replace('{ sidecar: () => local, browser: first.browser }','{ sidecar: () => local, browser: first.browser, generatedUIManager }');
fs.writeFileSync(path.join(source,'desktop/main.mjs'),main);
// Diagnostics only: print each disposal reason into the run log.
const hostPath = path.join(source,'desktop/generated-ui/host.mjs');
fs.writeFileSync(hostPath,fs.readFileSync(hostPath,'utf8').replace('audit = () => {}',"audit = event => { (globalThis.__generatedAudit ??= []).push(event); if (event.type === 'disposed') console.log('generated-ui disposed:', event.reason, 'remaining', event.remaining?.length) }"));
const policyPath = path.join(source,'desktop/generated-ui/policy.mjs');
const policy = fs.readFileSync(policyPath,'utf8');
const verified = process.argv.includes('--verified');
if (verified && sourceCode.some(file => file.production !== file.checkout)) throw new Error('Build the current package before running the verified lifecycle gate: '+sourceCode.filter(file=>file.production!==file.checkout).map(file=>file.file).join(', '));
if (!verified) fs.writeFileSync(policyPath,policy.replace(/export function runtimeCapability\([^]*?\nexport const GENERATED_WEB_PREFERENCES/,"export function runtimeCapability() { return { enabled: true, reason: 'Temporary packaged lifecycle gate only.' }; }\nexport const GENERATED_WEB_PREFERENCES"));
await createPackage(source,archive);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(path.join(root,'artifact.json'),JSON.stringify({sourceApp,sourceCode,retainedArchive:hash(path.join(resources,'app-production.asar')),instrumentedArchive:hash(archive),verifiedGateUnmodified:verified,method:'Temporary app copy, current host and shared validation, instrumented smoke dispatch/audit. Runtime binaries unchanged; original signature no longer covers changed test resources.',runtimeBinary:hash(path.join(targetApp,'Contents/MacOS/Apex Deck')),sourceRuntimeBinary:hash(path.join(sourceApp,'Contents/MacOS/Apex Deck')),bundledDaemon:hash(path.join(resources,'bin/apex-daemon')),sourceBundledDaemon:hash(path.join(sourceApp,'Contents/Resources/bin/apex-daemon'))},null,2));

const flow = {schemaVersion:1,kind:'generated',cardId:'intelligent-ui-flow',title:'How Intelligent UI works',summary:'Explore the stages from a question to a local interface.',html:'<h2>Intelligent UI</h2><svg viewBox="0 0 720 70" role="img" aria-label="Question to generated interface to sandbox"><rect width="720" height="70" rx="12" fill="#142337"/><text x="20" y="42" fill="white">Question → Generate UI → Validate → Run → Local controls</text></svg><p id="step" aria-live="polite">Ask a question</p><button id="next">Next stage</button><button id="reset">Reset</button><button id="discuss">Discuss this stage</button>',css:'body{font:16px system-ui;padding:16px}svg{width:100%;height:70px}button{margin:4px}',js:'const stages=["Ask a question","Generate HTML, CSS and JS","Validate the card","Approve this revision","Run in isolated sandbox","Use local controls"];let i=0;const draw=()=>document.querySelector("#step").textContent=stages[i];document.querySelector("#next").onclick=()=>{i=(i+1)%stages.length;draw()};document.querySelector("#reset").onclick=()=>{i=0;draw()};document.querySelector("#discuss").onclick=()=>generatedUI.discuss("Flow step: "+stages[i]);',fallback:'Question → generate HTML/CSS/JS → validate → approve revision → isolated sandbox → use local controls.'};
const calculator = {...flow,cardId:'calculator',title:'Local calculator',html:'<label for="amount">Amount</label><input id="amount" type="number" value="10"><output id="out" aria-live="polite">20</output><button id="reset">Reset</button>',js:'const i=document.querySelector("#amount"),o=document.querySelector("#out");i.oninput=()=>o.textContent=String((Number(i.value)||0)*2);document.querySelector("#reset").onclick=()=>{i.value="10";i.oninput()};',fallback:'Local calculator doubles the input; default 10 produces 20.'};
const chart = {...calculator,cardId:'chart',title:'Local chart',html:calculator.html+'<svg viewBox="0 0 400 70" role="img" aria-label="Value bar"><rect id="bar" width="200" height="60" fill="#6191ff"/></svg>',js:calculator.js+'i.addEventListener("input",()=>document.querySelector("#bar").setAttribute("width",String(Math.max(0,Math.min(400,(Number(i.value)||0)*20)))));',fallback:'Local bar chart starts at 10 and updates its bar with the input.'};
const providers=Object.fromEntries(['claude','codex'].map(name=>[name,JSON.parse(fs.readFileSync(path.join(repo,`tests/fixtures/generated-flowchart-${name}.json`),'utf8'))]));
for (const phase of process.env.APEX_PHASES?process.env.APEX_PHASES.split(','):process.argv.includes('--same-process')?['recovery']:['lifecycle','cycles','quit']) {
  const data = path.join(root,`data-${phase}`);fs.mkdirSync(path.join(data,'project'),{recursive:true});fs.mkdirSync(path.join(data,'project-moved'));
  fs.writeFileSync(path.join(data,'fixture.mjs'),`import fs from 'node:fs';const prompt=fs.readFileSync(0,'utf8');const flow=${JSON.stringify(flow)},calculator=${JSON.stringify(calculator)},chart=${JSON.stringify(chart)},providers=${JSON.stringify(providers)};const request=[...prompt.matchAll(/@fixture ([^\\n]+)/g)].at(-1)?.[1]??'flowchart';let card=request.startsWith('revised')?{...flow,title:'How Intelligent UI works — revision 2'}:request.startsWith('calculator')?calculator:request.startsWith('chart')?chart:request.startsWith('claude')?providers.claude:request.startsWith('codex')?providers.codex:flow;if(request.startsWith('freeze'))card={...flow,cardId:request.split(' ')[0],title:request.split(' ')[0],js:request.startsWith('freeze-init')?'while(true){}':request.startsWith('freeze-micro')?'setTimeout(()=>{const loop=()=>Promise.resolve().then(loop);loop()},100)':request.startsWith('freeze-allocation')?'setTimeout(()=>{const blocks=[];for(let n=0;n<128;n++){const b=new Uint8Array(1024*1024);b.fill(17);blocks.push(b)}while(true){}},100)':'setTimeout(()=>{while(true){}},100)'};process.stdout.write('Explore this local interface.\\n\\n'+String.fromCharCode(96).repeat(3)+'apex-ui\\n{');await new Promise(r=>setTimeout(r,1000));process.stdout.write(JSON.stringify(card).slice(1)+'\\n'+String.fromCharCode(96).repeat(3)+'\\n');`);
  const env={...process.env,APEX_DECK_DATA_DIR:data,APEX_DECK_SMOKE:'1',APEX_GENERATED_OUTPUT:root,APEX_GENERATED_PHASE:phase};
  const log=fs.openSync(path.join(root,`${phase}.log`),'w');
  const flags=process.argv.includes('--same-process')?['--disable-site-isolation-trials','--disable-features=IsolateOrigins,site-per-process']:[];
  const child=spawn(path.join(targetApp,'Contents/MacOS/Apex Deck'),flags,{env,stdio:['ignore',log,log]});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),240000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});
  clearTimeout(timeout);fs.closeSync(log);
  // An app that quits early also exits 0; only the gate's own record counts as a pass.
  const record=(()=>{try{return JSON.parse(fs.readFileSync(path.join(root,`${phase}.json`),'utf8'));}catch{return null;}})();
  if (phase === 'quit' && record?.passed === true) {
    const deadline = Date.now() + 10000;
    let remaining;
    do {
      remaining = record.processes.filter(({pid}) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }).map(({pid}) => pid);
      if (remaining.length) await new Promise(resolve => setTimeout(resolve, 50));
    } while (remaining.length && Date.now() < deadline);
    record.outerQuitCheck = { code, remaining, passed: code === 0 && remaining.length === 0 };
    record.passed = record.passed && record.outerQuitCheck.passed;
    fs.writeFileSync(path.join(root, `${phase}.json`), JSON.stringify(record, null, 2));
  }
  const passed=code===0&&record?.passed===true;
  console.log(JSON.stringify({phase,code,passed,checks:record?.checks?.length??0,evidence:root}));
  if(!passed){console.error(fs.readFileSync(path.join(root,`${phase}.log`),'utf8').slice(-9000));process.exitCode=1;break;}
}
console.log(`Packaged lifecycle evidence: ${root}`);
