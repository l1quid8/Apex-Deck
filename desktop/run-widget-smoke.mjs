// Run the real widget against an isolated daemon and deterministic tool-free model.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import electron from 'electron';

const data = fs.mkdtempSync('/tmp/apex-widget-smoke-');
const project = path.join(data, 'project');
const other = path.join(data, 'other');
fs.mkdirSync(project); fs.mkdirSync(other);
fs.writeFileSync(path.join(project, 'launch-plan.md'), '# November 1 launch\nSSO must pass before release.\n');
fs.writeFileSync(path.join(project, 'test-report.md'), '# SSO test report\nSSO tests are failing.\n');
fs.writeFileSync(path.join(project, 'CHANGELOG.md'), '# Changes\nNo release yet.\n');
fs.writeFileSync(path.join(other, 'README.md'), '# Other project\nReady to ship.\n');
let calls = 0;
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({data:[{id:'widget-test',object:'model'}]})); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(200, {'content-type':'text/html'}); res.end('<h1>Live browser test</h1>'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw); calls++;
  if (request.tools?.length) { res.writeHead(500); res.end('Monitoring must be tool-free'); return; }
  const text = JSON.stringify(request.messages);
  const deferred = text.includes('Defer SSO');
  const reply = {
    message: deferred ? 'SSO is deferred. Revised plan: keep November 1, release without SSO, and track SSO after launch.' : 'SSO tests are failing, and the launch plan requires SSO before release. Decide whether to defer SSO or move the date.',
    messageEvidence: deferred ? [] : [{id:'file:launch-plan.md'}, {id:'file:test-report.md'}],
    findings: deferred ? [] : [{summary:'SSO blocks the November 1 launch', reason:'The required SSO tests are failing.', confidence:'observed', nextStep:'Decide whether to defer SSO.', evidence:[{id:'file:launch-plan.md',quote:'SSO must pass before release.'},{id:'file:test-report.md',quote:'SSO tests are failing.'}]}],
    nextStep: deferred ? 'Monitor the remaining launch requirements.' : 'Ask the human about SSO.', nextCheckInMinutes:60, wakeReason:'Follow the launch requirements',
  };
  res.writeHead(200, {'content-type':'text/event-stream'});
  res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(reply)},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const profiles = [{id:'widget-test',display_name:'Widget test model',backend:{kind:'open_ai_compatible',base_url:`${url}/v1`,model:'widget-test'}}];
const saved = path.join(data, 'saved-chats-v1');
fs.mkdirSync(saved);
fs.writeFileSync(path.join(saved,'session.json'),JSON.stringify({version:1,canvasVersion:1,workspaces:[{id:'launch',name:'Mobile launch',path:project},{id:'other',name:'Other project',path:other}],panes:[],profiles,activeWorkspace:'launch',section:'threads',layouts:{}}));
const installed = process.argv.includes('--installed');
const packaged = installed || process.argv.includes('--packaged');
const program = installed ? '/Applications/Apex Deck.app/Contents/MacOS/Apex Deck' : packaged ? path.resolve(`release/mac-${process.arch}/Apex Deck.app/Contents/MacOS/Apex Deck`) : electron;
const child = spawn(program, packaged ? [] : ['.'], {stdio:'inherit', env:{...process.env,TMPDIR:'/tmp',APEX_DECK_DATA_DIR:data,APEX_DECK_SMOKE:'1',APEX_DECK_WIDGET_SMOKE:'1',APEX_WIDGET_SITE:url,APEX_WIDGET_SCREENSHOTS:'/tmp/apex-widget-screenshots'}});
const timer = setTimeout(()=>child.kill('SIGKILL'),180_000);
const code = await new Promise(resolve=>child.on('exit',(code)=>resolve(code??1)));
clearTimeout(timer); server.close();
console.log(`widget smoke: model requests ${calls}; exit ${code}; isolated data ${data}`);
process.exitCode = code;
