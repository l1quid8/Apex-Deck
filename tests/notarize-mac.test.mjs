import test from 'node:test';
import assert from 'node:assert/strict';
import { notarizeCredentials, notarizePlan, notarizeMessage, submitArgs, parseSubmission } from '../scripts/notarize-mac.mjs';

const id = 'A'.repeat(40);
const appleId = { APPLE_ID: 'person@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'fake-secret', APPLE_TEAM_ID: 'FAKETEAM01' };
const apiKey = { APPLE_API_KEY: '/keys/AuthKey_FAKE.p8', APPLE_API_KEY_ID: 'FAKEKEY', APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000' };

test('no credentials skips with a pointer to the setup doc', () => {
  assert.equal(notarizeCredentials({}), null);
  const plan = notarizePlan(id, {});
  assert.equal(plan.notarize, false);
  assert.match(notarizeMessage(plan), /^skipping notarization: no Apple notarization credentials .*docs\/notarization\.md/);
});

test('ad hoc signing skips even with credentials', () => {
  const plan = notarizePlan('-', appleId);
  assert.deepEqual(plan, { notarize: false, reason: 'ad hoc signing cannot be notarized' });
});

test('APEX_DECK_NOTARIZE=0 skips and =1 refuses to skip', () => {
  assert.equal(notarizePlan(id, { ...appleId, APEX_DECK_NOTARIZE: '0' }).notarize, false);
  assert.throws(() => notarizePlan(id, { APEX_DECK_NOTARIZE: '1' }), /no Apple notarization credentials/);
  assert.throws(() => notarizePlan('-', { ...appleId, APEX_DECK_NOTARIZE: '1' }), /Developer ID/);
  assert.equal(notarizePlan(id, { ...appleId, APEX_DECK_NOTARIZE: '1' }).notarize, true);
  assert.throws(() => notarizePlan(id, { APEX_DECK_NOTARIZE: 'yes' }), /0, 1 or unset/);
});

test('each credential set maps to notarytool arguments in electron-builder order', () => {
  assert.deepEqual(notarizeCredentials(appleId).args,
    ['--apple-id', 'person@example.com', '--password', 'fake-secret', '--team-id', 'FAKETEAM01']);
  assert.deepEqual(notarizeCredentials(apiKey).args,
    ['--key', '/keys/AuthKey_FAKE.p8', '--key-id', 'FAKEKEY', '--issuer', '00000000-0000-0000-0000-000000000000']);
  assert.deepEqual(notarizeCredentials({ APPLE_KEYCHAIN_PROFILE: 'apex-deck-notary' }).args, ['--keychain-profile', 'apex-deck-notary']);
  assert.deepEqual(notarizeCredentials({ APPLE_KEYCHAIN_PROFILE: 'p', APPLE_KEYCHAIN: '/k.keychain-db' }).args,
    ['--keychain-profile', 'p', '--keychain', '/k.keychain-db']);
  // Apple ID wins over the others, as it does in electron-builder.
  assert.equal(notarizeCredentials({ ...apiKey, ...appleId, APPLE_KEYCHAIN_PROFILE: 'p' }).mode, 'Apple ID');
});

test('a partial credential set fails and names only what is missing', () => {
  assert.throws(() => notarizePlan(id, { APPLE_ID: 'person@example.com' }), error =>
    /APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/.test(error.message) && !error.message.includes('person@example.com'));
  assert.throws(() => notarizePlan(id, { APPLE_API_KEY_ID: 'FAKEKEY' }), error =>
    /APPLE_API_KEY, APPLE_API_ISSUER/.test(error.message) && !error.message.includes('FAKEKEY'));
});

test('log lines never carry a credential, Apple ID or team id', () => {
  for (const env of [appleId, apiKey, { APPLE_KEYCHAIN_PROFILE: 'secret-profile-name' }]) {
    const message = notarizeMessage(notarizePlan(id, env));
    assert.match(message, /^notarizing with /);
    for (const value of Object.values(env)) assert.ok(!message.includes(value));
  }
});

test('submission waits for Apple and only Accepted passes', () => {
  const plan = notarizePlan(id, { APPLE_KEYCHAIN_PROFILE: 'p' });
  assert.deepEqual(submitArgs('/r/a.dmg', plan),
    ['notarytool', 'submit', '/r/a.dmg', '--keychain-profile', 'p', '--wait', '--output-format', 'json']);
  assert.deepEqual(parseSubmission('{"id":"abc","status":"Accepted","message":"ok"}'), { id: 'abc', status: 'Accepted', accepted: true });
  assert.equal(parseSubmission('{"id":"abc","status":"Invalid"}').accepted, false);
  assert.throws(() => parseSubmission('Error: HTTP 401'), /no readable result/);
  assert.throws(() => parseSubmission('{"message":"x"}'), /no submission id/);
});
