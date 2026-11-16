import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tsType, render, taggedVariants } from '../scripts/gen-protocol-types.mjs';

const SCRIPT = join(process.cwd(), 'scripts/gen-protocol-types.mjs');

test('scalars, nullables, arrays, tuples and maps', () => {
  assert.equal(tsType({ type: 'string' }), 'string');
  assert.equal(tsType({ type: 'integer', format: 'uint64', minimum: 0 }), 'number');
  assert.equal(tsType({ type: ['string', 'null'] }), 'string | null');
  assert.equal(tsType({ anyOf: [{ $ref: '#/$defs/Message' }, { type: 'null' }] }), 'Message | null');
  assert.equal(tsType({ type: 'array', items: { type: 'boolean' } }), 'Array<boolean>');
  assert.equal(tsType({ type: 'array', prefixItems: [{ type: 'number' }, { type: 'string' }] }), '[number, string]');
  assert.equal(tsType({ type: 'object', additionalProperties: { type: 'number' } }), 'Record<string, number>');
  assert.equal(tsType({ type: 'object' }), 'Record<string, never>');
  assert.equal(tsType({}), 'unknown');
  assert.equal(tsType(true), 'unknown');
  assert.equal(tsType({ enum: ['read', 'ask'] }), '"read" | "ask"');
  assert.equal(tsType({ type: 'string', const: 'room_post' }), '"room_post"');
});

test('a $ref of "#" is the type being rendered, as a recursive enum refers to itself', () => {
  assert.equal(tsType({ type: 'object', required: ['event'], properties: { event: { $ref: '#' } } }, '', 'RoomEvent'), '{\n  event: RoomEvent;\n}');
  assert.throws(() => tsType({ $ref: '#' }), /outside a named root/);
});

test('objects keep required and optional apart, quote odd keys, and carry descriptions', () => {
  const t = tsType({ type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'The thread.' }, 'client-id': { type: ['string', 'null'] } } });
  assert.equal(t, '{\n  /** The thread. */\n  id: string;\n  "client-id"?: string | null;\n}');
});

const fixture = {
  protocol: 1,
  capabilities: ['monitor', 'chat_rooms'],
  schemas: {
    Command: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Command', description: 'Every command.',
      oneOf: [
        { type: 'object', required: ['cmd', 'args'], properties: { cmd: { type: 'string', const: 'room_post' }, args: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' }, interactiveAnswers: { type: ['boolean', 'null'] } } } } },
        { type: 'object', required: ['cmd', 'args'], properties: { cmd: { type: 'string', const: 'room_state' }, args: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
        { type: 'object', required: ['cmd', 'args'], properties: { cmd: { type: 'string', const: 'chat_profiles' }, args: { type: 'object' } } },
        { type: 'object', required: ['cmd', 'args'], properties: { cmd: { type: 'string', const: 'room_add_participant' }, args: { type: 'object', required: ['id', 'participant'], properties: { id: { type: 'string' }, participant: { $ref: '#/$defs/ParticipantConfig' } } } } },
      ],
      $defs: { ParticipantConfig: { type: 'object', description: 'One bot.', required: ['name', 'access'], properties: { name: { type: 'string' }, access: { $ref: '#/$defs/Access' } } }, Access: { type: 'string', enum: ['read', 'ask', 'edits', 'full'] } },
    },
    RoomEvent: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'RoomEvent',
      oneOf: [
        { type: 'object', required: ['type'], properties: { type: { type: 'string', const: 'state_changed' } } },
        { type: 'object', required: ['type', 'participant'], properties: { type: { type: 'string', const: 'participant_changed' }, participant: { $ref: '#/$defs/ParticipantConfig' } } },
      ],
      $defs: { ParticipantConfig: { type: 'object', description: 'One bot.', required: ['name', 'access'], properties: { name: { type: 'string' }, access: { $ref: '#/$defs/Access' } } }, Access: { type: 'string', enum: ['read', 'ask', 'edits', 'full'] } },
    },
    HostEvent: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'HostEvent',
      oneOf: [
        { type: 'object', required: ['name', 'payload'], properties: { name: { type: 'string', const: 'pty-exit' }, payload: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, code: { type: ['integer', 'null'] } } } } },
        { type: 'object', required: ['name', 'payload'], properties: { name: { type: 'string', const: 'quit-requested' }, payload: { type: 'integer', format: 'uint64' } } },
      ],
    },
    Welcome: { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Welcome', type: 'object', required: ['protocol', 'capabilities'], properties: { protocol: { type: 'integer' }, capabilities: { type: 'array', items: { type: 'string' } } } },
  },
};

test('the rendered file has the constants, every named type once, the roots, and the command and event maps', () => {
  const text = render(fixture);
  assert.match(text, /^\/\/ Generated by scripts\/gen-protocol-types\.mjs/);
  assert.match(text, /export const PROTOCOL = 1 as const;/);
  assert.match(text, /export const CAPABILITIES = \["monitor", "chat_rooms"\] as const;\nexport type Capability = \(typeof CAPABILITIES\)\[number\];/);
  assert.equal(text.match(/export type ParticipantConfig = /g).length, 1, 'shared defs appear once');
  assert.match(text, /export type Access = "read" \| "ask" \| "edits" \| "full";/);
  assert.match(text, /\/\*\* One bot\. \*\/\nexport type ParticipantConfig = \{\n  name: string;\n  access: Access;\n\};/);
  assert.match(text, /\/\*\* Every command\. \*\/\nexport type Command = \{\n/);
  assert.match(text, /export interface Commands \{\n  chat_profiles: Record<string, never>;\n  room_add_participant: \{\n    id: string;\n    participant: ParticipantConfig;\n  \};\n  room_post: \{\n    id: string;\n    text: string;\n    interactiveAnswers\?: boolean \| null;\n  \};\n  room_state: \{\n    id: string;\n  \};\n\}\nexport type CommandName = keyof Commands;/);
  assert.match(text, /export interface HostEvents \{\n  "pty-exit": \{\n    id: string;\n    code\?: number \| null;\n  \};\n  "quit-requested": number;\n\}\nexport type HostEventName = keyof HostEvents;/);
  assert.match(text, /export type RoomEvent = \{\n  type: "state_changed";\n\} \| \{\n  type: "participant_changed";\n  participant: ParticipantConfig;\n\};/);
  assert.match(text, /export type Welcome = \{/);
});

test('a root type nested in another root is written once', () => {
  const nested = structuredClone(fixture);
  nested.schemas.HostEvent.$defs = { RoomEvent: { oneOf: [{ type: 'object', required: ['type'], properties: { type: { type: 'string', const: 'state_changed' } } }] } };
  nested.schemas.HostEvent.oneOf.push({ type: 'object', required: ['name', 'payload'], properties: { name: { type: 'string', const: 'room-event' }, payload: { type: 'object', required: ['event'], properties: { event: { $ref: '#/$defs/RoomEvent' } } } } });
  const text = render(nested);
  assert.equal(text.match(/^export type RoomEvent = /gm).length, 1);
  assert.match(text, /"room-event": \{\n    event: RoomEvent;\n  \};/);
});

test('two different types with one name are refused, so the fix happens in Rust', () => {
  const clash = structuredClone(fixture);
  clash.schemas.RoomEvent.$defs.Access = { type: 'string', enum: ['read'] };
  assert.throws(() => render(clash), /Two different types are both called Access/);
});

test('taggedVariants reads the constant name of each variant', () => {
  const v = taggedVariants(fixture.schemas.Command, 'cmd', 'args');
  assert.deepEqual([...v.keys()], ['room_post', 'room_state', 'chat_profiles', 'room_add_participant']);
  assert.deepEqual(v.get('chat_profiles'), { type: 'object' });
});

test('the command writes from a saved schema, says when nothing changed, and --check fails on drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-protocol-'));
  try {
    const from = join(dir, 'schema.json'), out = join(dir, 'protocol.ts');
    writeFileSync(from, JSON.stringify(fixture));
    const w = spawnSync(process.execPath, [SCRIPT, '--from', from, '--out', out], { encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stdout, /wrote /);
    assert.equal(readFileSync(out, 'utf8'), render(fixture) + '\n');
    const again = spawnSync(process.execPath, [SCRIPT, '--from', from, '--out', out], { encoding: 'utf8' });
    assert.match(again.stdout, /unchanged/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--from', from, '--out', out, '--check'], { encoding: 'utf8' }).status, 0);
    writeFileSync(out, '// stale\n');
    const drift = spawnSync(process.execPath, [SCRIPT, '--from', from, '--out', out, '--check'], { encoding: 'utf8' });
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /out of date/);
    assert.equal(readFileSync(out, 'utf8'), '// stale\n', '--check writes nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the rendered fixture is valid TypeScript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-protocol-tsc-'));
  try {
    writeFileSync(join(dir, 'protocol.ts'), render(fixture) + '\n');
    writeFileSync(join(dir, 'use.ts'), `import { Commands, HostEvents, PROTOCOL, type Capability } from './protocol';\nconst args: Commands['room_post'] = { id: 'r', text: 'hi' };\nconst code: HostEvents['pty-exit']['code'] = null;\nconst cap: Capability = 'monitor';\nexport const ok = [args, code, cap, PROTOCOL] as const;\n`);
    // Run the local compiler through node: Windows has npx.cmd, which spawning without a shell can't find.
    const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
    const r = spawnSync(process.execPath, [tsc, '--ignoreConfig', '--noEmit', '--strict', '--target', 'es2022', '--moduleResolution', 'bundler', '--module', 'esnext', join(dir, 'protocol.ts'), join(dir, 'use.ts')], { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
