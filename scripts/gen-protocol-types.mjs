#!/usr/bin/env node
// Write src/generated/protocol.ts from the daemon's wire types.
//
//   node scripts/gen-protocol-types.mjs                 # build the schema printer and write the file
//   node scripts/gen-protocol-types.mjs --check         # exit 1 if the file would change (CI)
//   node scripts/gen-protocol-types.mjs --from s.json   # from a saved `apex-protocol-schema` output
//   node scripts/gen-protocol-types.mjs --schema-out s.json   # also keep the schema
//
// The Rust side is the source of truth: `Command`, `RoomEvent`, `HostEvent`
// and `Welcome` derive `schemars::JsonSchema`, and the `apex-protocol-schema`
// binary in apex-daemon prints them with the protocol number and capability
// list. This script turns that JSON Schema into TypeScript with no other
// dependency. A type that changes in Rust changes here, and CI fails until the
// generated file is committed again (`protocol-types` job in daemon.yml).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUTPUT = 'src/generated/protocol.ts';

// ---------------------------------------------------------------- schema → ts

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name) => (IDENT.test(name) ? name : JSON.stringify(name));
/** The name a `$ref` points at: a named type, or the root (`#`) of the document being rendered. */
const refName = (ref, root) => {
  if (ref === '#') {
    if (!root) throw new Error('A $ref to "#" outside a named root');
    return root;
  }
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) throw new Error(`Unsupported $ref ${ref}`);
  return m[1];
};

/** One JSON Schema node as a TypeScript type expression. `root` names the document, for `$ref: "#"`. */
export function tsType(node, indent = '', root = undefined) {
  if (node === true || (typeof node === 'object' && node !== null && Object.keys(node).length === 0)) return 'unknown';
  if (node === false) return 'never';
  if (node.$ref) return refName(node.$ref, root);
  if (node.enum) return node.enum.map(v => JSON.stringify(v)).join(' | ');
  if ('const' in node) return JSON.stringify(node.const);
  const union = node.oneOf || node.anyOf;
  if (union) {
    const parts = union.map(n => tsType(n, indent, root));
    // Option<Ref> comes out as anyOf [ref, null]; keep it on one line.
    return parts.length === 1 ? parts[0] : parts.join(' | ');
  }
  if (node.allOf) return node.allOf.map(n => `(${tsType(n, indent, root)})`).join(' & ');
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length === 0 && node.properties) types.push('object');
  if (types.length === 0) return 'unknown';
  const one = (t) => {
    switch (t) {
      case 'string': return 'string';
      case 'integer': case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'array': {
        if (Array.isArray(node.prefixItems)) return `[${node.prefixItems.map(n => tsType(n, indent, root)).join(', ')}]`;
        if (Array.isArray(node.items)) return `[${node.items.map(n => tsType(n, indent, root)).join(', ')}]`;
        if (Number.isSafeInteger(node.minItems) && node.minItems >= 0 && node.minItems <= 32 && node.minItems === node.maxItems)
          return `[${Array(node.minItems).fill(tsType(node.items ?? true, indent, root)).join(', ')}]`;
        return node.items ? `Array<${tsType(node.items, indent, root)}>` : 'unknown[]';
      }
      case 'object': return objectType(node, indent, root);
      default: throw new Error(`Unsupported type ${t}`);
    }
  };
  return types.map(one).join(' | ');
}

function doc(text, indent) {
  if (!text) return '';
  const lines = String(text).trim().split('\n');
  return lines.length === 1 ? `${indent}/** ${lines[0]} */\n` : `${indent}/**\n${lines.map(l => `${indent} * ${l}`.trimEnd()).join('\n')}\n${indent} */\n`;
}

function objectType(node, indent, root) {
  const props = node.properties || {};
  const required = new Set(node.required || []);
  const names = Object.keys(props);
  const extra = node.additionalProperties;
  if (names.length === 0) {
    if (extra && extra !== false) return `Record<string, ${tsType(extra, indent, root)}>`;
    return 'Record<string, never>';
  }
  const inner = indent + '  ';
  const lines = names.map(name => `${doc(props[name].description, inner)}${inner}${key(name)}${required.has(name) ? '' : '?'}: ${tsType(props[name], inner, root)};`);
  const body = `{\n${lines.join('\n')}\n${indent}}`;
  return extra && extra !== false ? `${body} & Record<string, ${tsType(extra, indent, root)}>` : body;
}

/** The variants of an adjacently tagged enum (`tag`, `content`) as name → content schema. */
export function taggedVariants(schema, tag, content) {
  const out = new Map();
  for (const variant of schema.oneOf || schema.anyOf || []) {
    const name = variant.properties?.[tag]?.const ?? variant.properties?.[tag]?.enum?.[0];
    if (typeof name !== 'string') throw new Error(`A ${tag} variant has no constant name: ${JSON.stringify(variant).slice(0, 120)}`);
    out.set(name, variant.properties?.[content] ?? { type: 'object' });
  }
  return out;
}

/** The whole file, from the printer's JSON. */
export function render(input) {
  const { protocol, capabilities, schemas } = input;
  if (!Number.isInteger(protocol) || !Array.isArray(capabilities) || !schemas) throw new Error('Not a protocol schema document');
  // One namespace of named types. The same Rust type gives the same schema in
  // every root; two different types with one name are an error to fix in Rust
  // (`#[schemars(rename = "…")]`).
  const defs = new Map();
  for (const [root, schema] of Object.entries(schemas)) {
    for (const [name, def] of Object.entries(schema.$defs || schema.definitions || {})) {
      const text = JSON.stringify(def);
      if (defs.has(name) && defs.get(name).text !== text) throw new Error(`Two different types are both called ${name} (seen again under ${root})`);
      defs.set(name, { def, text, root });
    }
  }
  const strip = (schema) => { const { $schema, $defs, definitions, title, ...rest } = schema; return rest; };
  const out = [];
  out.push('// Generated by scripts/gen-protocol-types.mjs from the daemon\'s wire types. Do not edit;');
  out.push('// change the Rust type and run `node scripts/gen-protocol-types.mjs`.');
  out.push('/* eslint-disable */');
  out.push('');
  out.push(`/** The wire protocol number the daemon's hello must match exactly. */`);
  out.push(`export const PROTOCOL = ${protocol} as const;`);
  out.push('');
  out.push('/** What a daemon may list in its welcome; clients gate features on these. */');
  out.push(`export const CAPABILITIES = [${capabilities.map(c => JSON.stringify(c)).join(', ')}] as const;`);
  out.push('export type Capability = (typeof CAPABILITIES)[number];');
  out.push('');
  // A root type also nested in another root (RoomEvent inside HostEvent) is written once, as the root.
  for (const name of [...defs.keys()].filter(n => !(n in schemas)).sort()) {
    const { def, root } = defs.get(name);
    out.push(`${doc(def.description, '')}export type ${name} = ${tsType(def, '', root)};`);
    out.push('');
  }
  for (const [root, schema] of Object.entries(schemas)) {
    out.push(`${doc(schema.description, '')}export type ${root} = ${tsType(strip(schema), '', root)};`);
    out.push('');
  }
  if (schemas.Command) {
    out.push('/** Every command name and the `args` it takes: `call("room_post", args)`. */');
    out.push('export interface Commands {');
    const commandSchemas = Object.entries(schemas).filter(([name]) => name === 'Command' || name.endsWith('Request'));
    const requests = commandSchemas.flatMap(([root, schema]) =>
      [...taggedVariants(schema, 'cmd', 'args')].map(([name, args]) => [name, args, root]));
    if (new Set(requests.map(([name]) => name)).size !== requests.length) throw new Error('Duplicate wire command name');
    for (const [name, args, root] of requests.sort(([a], [b]) => (a < b ? -1 : 1))) {
      out.push(`  ${key(name)}: ${tsType(args, '  ', root)};`);
    }
    out.push('}');
    out.push('export type CommandName = keyof Commands;');
    out.push('');
  }
  if (schemas.HostEvent) {
    out.push('/** Every event name and its `payload`, as the `{seq, event, payload}` frames carry them. */');
    out.push('export interface HostEvents {');
    for (const [name, payload] of [...taggedVariants(schemas.HostEvent, 'name', 'payload')].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out.push(`  ${key(name)}: ${tsType(payload, '  ', 'HostEvent')};`);
    }
    out.push('}');
    out.push('export type HostEventName = keyof HostEvents;');
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- command line

function schemaFromCargo(repo) {
  const text = execFileSync('cargo', ['run', '-q', '-p', 'apex-daemon', '--bin', 'apex-protocol-schema'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(text);
}

function main(argv) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let from, out = resolve(repo, OUTPUT), check = false, schemaOut;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--out') out = resolve(argv[++i]);
    else if (a === '--schema-out') schemaOut = resolve(argv[++i]);
    else if (a === '--check') check = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  const input = from ? JSON.parse(readFileSync(from, 'utf8')) : schemaFromCargo(repo);
  if (schemaOut) writeFileSync(schemaOut, JSON.stringify(input, null, 2) + '\n');
  const text = render(input) + '\n';
  const current = existsSync(out) ? readFileSync(out, 'utf8') : null;
  if (check) {
    if (current === text) { console.log(`OK: ${out} is up to date`); return 0; }
    console.error(`${out} is out of date${current === null ? ' (missing)' : ''}; run node scripts/gen-protocol-types.mjs and commit the result`);
    return 1;
  }
  if (current === text) { console.log(`unchanged: ${out}`); return 0; }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out} (${text.split('\n').length} lines)`);
  return 0;
}

// A URL pathname is /D:/a/... on Windows and percent-encodes spaces, so compare file paths.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { console.error(`gen-protocol-types: ${e.message}`); process.exit(1); }
}
