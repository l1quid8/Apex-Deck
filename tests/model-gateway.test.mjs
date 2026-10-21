import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayApi, gatewayOwner, issueGatewaySpec } from '../src/modelGateway.ts';

test('only the local desktop owner gets gateway management', () => {
  assert.equal(gatewayOwner({demo: false, gatewayAdmin: true, host: {id: 'local'}}), true);
  for (const backend of [{demo: true, gatewayAdmin: true, host: {id:'local'}}, {demo:false}, {demo:false, gatewayAdmin:true, host:{id:'ssh-friend'}}, {demo:false,host:{id:'local'}}]) assert.equal(gatewayOwner(backend), false);
});

test('issuance validates limits and never enables private MCP', () => {
  assert.deepEqual(issueGatewaySpec(' Rig ', 'all', '100', '25'), {label:'Rig', scopes:['sub','api','cli'], allowMcp:false, maxTurnsPerDay:100, maxUsdMicrosPerMonth:25000000});
  for (const [label, cap, budget] of [[' ', '1',''], ['a','0',''], ['a','1.5',''], ['a','NaN',''], ['a','10001',''], ['a','5','Infinity'], ['a','5','-1'], ['a','5','0']]) assert.throws(() => issueGatewaySpec(label,'api',cap,budget));
  assert.equal(issueGatewaySpec('Rig','api','','').maxTurnsPerDay, null);
});

test('gateway API uses the existing local-only commands and rejects remote use before sending', async () => {
  const sent=[];
  const backend={demo:false, gatewayAdmin:true, host:{id:'local'}, call:async(cmd,args)=>{sent.push([cmd,args]); return {keys:[]};}};
  const api=gatewayApi(backend);
  await api.status(); await api.list(); await api.providers(); await api.configure({enabled:true,bind:'127.0.0.1',port:8787});
  await api.issue(issueGatewaySpec('Rig','api','100','')); await api.revoke('id');
  assert.deepEqual(sent.map(x=>x[0]), ['gateway_status','gateway_keys_list','gateway_providers','gateway_configure','gateway_keys_issue','gateway_keys_revoke']);
  const remote=gatewayApi({...backend,host:{id:'remote'}});
  await assert.rejects(remote.list(), /host owner/);
  assert.equal(sent.length,6);
});
