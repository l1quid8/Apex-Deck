import {test} from 'node:test';import assert from 'node:assert/strict';
import {stripRunnerReport} from '../src/runner/report.ts';
import {runnerView} from '../src/runner/viewModel.ts';
const report=JSON.stringify({version:1,disposition:'done',done:'Result',next:'',blocker:null,criteria:[]});
test('hide only a valid final top-level control report; retain quotes, examples and malformed replies',()=>{
 const fence='```apex-runner\n'+report+'\n```';
 assert.equal(stripRunnerReport('Work\n'+fence),'Work');
 for(const text of ['> '+fence,'````markdown\n'+fence+'\n````',fence+'\nExplanation after fence','```apex-runner\n{}\n```'])assert.equal(stripRunnerReport(text),text);
});
test('attention status overrides progress on narrow displays; paused loop has no ticking next run',()=>{
 const s={id:'r',kind:'loop',phase:'paused',reason:'stuck',limits:{},usage:{},nextRunAt:15000};
 assert.equal(runnerView(s,1000).metric,'Needs you');
 assert.equal(runnerView({...s,reason:'human'},1000).metric,'Paused');
 assert.equal(runnerView({...s,dismissed:true},1000),null);
});
