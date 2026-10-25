import test from 'node:test';
import assert from 'node:assert/strict';
const runtime = await import('../src/assistantRuntime.ts');
const profile = { id: 'saved-profile', display_name: 'Null', persona: 'Retain persona', access: 'ask', effort: 'high', voice: 'voice-a', backend: { kind: 'agent', tool: 'claude_code', model: 'old' } };
const record = { id: 'assistant-a', hostId: 'host-a', revision: 7, name: 'Null', profile, projects: [{ project: { hostId: 'host-a', workspaceId: 'w', cwd: '/granted' }, tools: 'ask' }], costs: [], contextBudgetChars: 8000 };

test('runtime usage distinguishes unknown and partially reported tokens from zero and context occupancy', () => {
  assert.deepEqual(runtime.assistantRuntimeUsage(record), { tokens: 'Saved assistant history: token usage unavailable', context: 'Context usage unavailable · 8,000 character budget', resets: 'Provider usage and reset times unavailable' });
  const costs = [{ source: 'reported', inputTokens: 120, outputTokens: 30 }, { source: 'estimated', inputTokens: 500, outputTokens: 20 }, { source: 'reported' }];
  assert.equal(runtime.assistantRuntimeUsage({ ...record, costs })?.tokens, 'Saved assistant history across providers (partial): 620 in · 50 out · other usage unavailable');
});

test('provider switching clones only the selected backend and reconciles reasoning without changing assistant identity or grants', () => {
  const selected = { ...profile, id: 'reusable-provider', display_name: 'Reusable', access: 'full', voice: 'other', backend: { kind: 'open_ai_compatible', base_url: 'https://api.example/v1', model: 'selected' } };
  const result = runtime.assistantProviderProfile(profile, selected, [{ id: 'selected', efforts: ['low', 'medium'] }]);
  assert.deepEqual(result, { ...profile, backend: selected.backend, effort: 'low', speed: null });
  assert.notEqual(result.backend, selected.backend);
  assert.equal(selected.id, 'reusable-provider');
  assert.equal(selected.access, 'full');
});

test('runtime save uses captured owner revision, never creates a room and preserves project grants', async () => {
  let durable = structuredClone(record); const writes = [], reads = [];
  const lane = { assistant: structuredClone(record), ref: { hostId: 'host-a', assistantId: 'assistant-a' }, offline: false, configureWorkspace: async input => { writes.push(input); durable = { ...durable, revision: durable.revision + 1, profile: input.profile }; } };
  const backend = { call: async (command, args) => { reads.push([command, args]); return structuredClone(durable); }, roomCreate: async () => { throw Error('must not create a room'); } };
  const session = runtime.createAssistantRuntimeSession(lane, backend);
  const base = await session.loadCurrent();
  await session.save({ ...profile, backend: { ...profile.backend, model: 'new' } }, base);
  assert.deepEqual(writes.map(w => [w.expectedRevision, w.profile.backend.model, Object.hasOwn(w, 'projects')]), [[7, 'new', false]]);
  assert.deepEqual(reads, [['personal_get', { assistantId: 'assistant-a' }]]);
  assert.equal((await session.loadCurrent()).backend.model, 'new');
  await session.save({ ...durable.profile, effort: 'low' }, await session.loadCurrent());
  assert.equal(writes[1].expectedRevision, 8);
  assert.deepEqual(lane.assistant.projects, record.projects);
});

test('runtime conflicts do not advance the captured revision or modify the reusable profile', async () => {
  const revisions = [];
  const session = runtime.createAssistantRuntimeSession({ assistant: record, offline: false, configureWorkspace: async input => { revisions.push(input.expectedRevision); throw Error('Revision conflict'); } }, { call: async () => { throw Error('must not read after failure'); } });
  if (!session) { assert.fail('runtime session not implemented'); }
  for (let n = 0; n < 2; n++) await assert.rejects(session.save({ ...profile, effort: 'low' }, profile), /Revision conflict/);
  assert.deepEqual(revisions, [7, 7]);
  assert.equal(profile.effort, 'high');
});

test('runtime read-back rejects a different assistant rather than using its revision', async () => {
  const session = runtime.createAssistantRuntimeSession({ assistant: record, offline: false, configureWorkspace: async () => {} }, { call: async () => ({ ...record, id: 'other', revision: 99 }) });
  if (!session) { assert.fail('runtime session not implemented'); }
  await assert.rejects(session.save({ ...profile, effort: 'low' }, profile), /different assistant/);
});

test('partial token reports never invent a zero for an unreported direction', () => {
  const usage = runtime.assistantRuntimeUsage({ ...record, costs: [{ source: 'reported', inputTokens: 120 }] });
  assert.equal(usage.tokens, 'Saved assistant history across providers (partial): 120 in · unavailable out · other usage unavailable');
});

test('reported token counts remain visible when the provider did not report a dollar cost', () => {
  const usage = runtime.assistantRuntimeUsage({ ...record, costs: [{ source: 'unknown', inputTokens: 80, outputTokens: 20 }] });
  assert.equal(usage.tokens, 'Saved assistant history across providers (partial): 80 in · 20 out');
});

test('token totals explicitly describe saved assistant history across providers rather than the selected runtime quota', () => {
  const usage = runtime.assistantRuntimeUsage({ ...record, costs: [{ source: 'reported', endpoint: 'old-provider', inputTokens: 40, outputTokens: 5 }, { source: 'reported', endpoint: 'new-provider', inputTokens: 60, outputTokens: 15 }] });
  assert.match(usage.tokens, /Saved assistant history across providers \(partial\)/);
});

test('runtime providers are loaded from the owning host and include known text agents',async()=>{
 const remote={id:'remote',display_name:'Remote account',backend:{kind:'open_ai_compatible',base_url:'https://remote.test/v1',model:'remote-text'}};
 const providers=await runtime.loadAssistantRuntimeProviders({sessionLoad:async()=>({profiles:[remote,{id:'codex',backend:{kind:'agent',tool:'codex'}},{id:'claude',backend:{kind:'agent',tool:'claude_code'}},{id:'image',media:{},backend:{kind:'open_ai_compatible',base_url:'https://remote.test'}}]})});
 assert.deepEqual(providers.map(p=>p.id),['remote','codex','claude']);
});

test('assistant runtimes use actual discovery wire keys and fail closed for missing workers',async()=>{
 const models=[],backend={detectAgents:async()=>[{key:'claude',label:'Claude Code',program:'claude',found:true}],agentModels:async tool=>{models.push(tool);return[{id:'sonnet'}];}};
 assert.deepEqual(await runtime.assistantRuntimeModels(backend,profile),[{id:'sonnet'}]);assert.deepEqual(models,['claude_code']);
 await assert.rejects(runtime.assistantRuntimeModels({...backend,detectAgents:async()=>[{key:'claude',label:'Claude Code',program:'claude',found:false}]},profile),/not installed/);
 assert.deepEqual(await runtime.assistantRuntimeModels({...backend,detectAgents:async()=>[{key:'codex',found:true}]},{...profile,backend:{kind:'agent',tool:'codex'}}),[{id:'sonnet'}]);
});

 test('installed providers appear even without a reusable agent profile, with configured accounts kept first',async()=>{
 const api={id:'api',display_name:'Configured API',backend:{kind:'open_ai_compatible',base_url:'https://own.test/v1',model:'text'}};
 const rows=await runtime.loadAssistantRuntimeProviders({sessionLoad:async()=>({profiles:[api]}),detectAgents:async()=>[{key:'claude',label:'Claude Code',program:'claude',found:true},{key:'codex',label:'Codex',program:'codex',found:true},{key:'gemini',label:'Antigravity / Gemini',program:'agy',found:true},{key:'grok',label:'Grok',program:'grok',found:false},{key:'muse',label:'Muse',program:'muse',found:true},{key:'unknown',label:'Custom',program:'custom',found:true}]});
 assert.equal(rows[0].id,'api');assert.deepEqual(rows.slice(1).map(p=>p.backend.tool),['claude_code','codex','gemini','grok','muse']);
 assert.equal(new Set(rows.map(p=>p.id)).size,rows.length);
 });
 test('Antigravity remains visible but shared background service cannot be selected as isolated Gemini inference',async()=>{
 const candidate={...profile,backend:{kind:'agent',tool:'gemini'}};
 await assert.rejects(runtime.assistantRuntimeModels({detectAgents:async()=>[{key:'gemini',program:'agy',found:true}],agentModels:async()=>{throw Error('must not discover shared service');}},candidate),/Antigravity.*Gemini CLI/);
 });

test('an older owning host keeps providers visible but refuses new agent runtimes with an update explanation',async()=>{
 const codex={...profile,backend:{kind:'agent',tool:'codex'}};
 const backend={supports:()=>false,detectAgents:async()=>[{key:'codex',found:true}],agentModels:async()=>[{id:'offered'}]};
 await assert.rejects(runtime.assistantRuntimeModels(backend,codex),/Update.*assistant.*machine/);
 const providers=await runtime.loadAssistantRuntimeProviders({...backend,sessionLoad:async()=>({profiles:[codex]})});
 assert.equal(providers[0].backend.tool,'codex');
});

test('coinstalled Gemini CLI is selectable independently of Threads Antigravity preference',async()=>{
 const candidate={...profile,backend:{kind:'agent',tool:'gemini',model:'antigravity-only'}};
 const models=await runtime.assistantRuntimeModels({detectAgents:async()=>[{key:'gemini',program:'agy',assistantProgram:'gemini',found:true}],agentModels:async()=>{throw Error('must not reuse the Antigravity model catalog');}},candidate);
 assert.deepEqual(models,[{id:'',label:'Provider default',efforts:[]}]);
 const next=runtime.assistantProviderProfile(profile,candidate,models);
 assert.equal(next.backend.model,null);assert.equal(next.effort,null);assert.equal(next.id,profile.id);
});
test('CLI without a catalog can use its provider default or retain an explicitly configured model',async()=>{
 const backend={detectAgents:async()=>[{key:'claude',program:'claude',found:true}],agentModels:async()=>[]};
 const defaults=await runtime.assistantRuntimeModels(backend,{...profile,backend:{kind:'agent',tool:'claude_code',model:null},effort:null});
 assert.deepEqual(defaults,[{id:'',label:'Provider default',efforts:[]}]);
 const saved=await runtime.assistantRuntimeModels(backend,profile);
 assert.equal(saved[0].id,'old');assert.deepEqual(saved[0].efforts,['high']);
});
