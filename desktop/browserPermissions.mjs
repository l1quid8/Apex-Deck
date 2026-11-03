// What sites in the docked browser may use: the microphone and the camera, asked
// per site. Only an answer the person chose to remember is saved.

import fs from 'node:fs';

const KINDS = { audio: 'microphone', video: 'camera' };

/** The saved answers as `{ origin: { microphone: true, camera: false } }`. */
export function siteMemory(file) {
  let saved = {};
  try {
    const read = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (read && typeof read === 'object') saved = read;
  } catch { /* nothing saved yet */ }
  const save = () => fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return {
    get: (origin, kind) => saved[origin]?.[kind],
    remember(origin, kinds, allowed) {
      saved[origin] = { ...saved[origin], ...Object.fromEntries(kinds.map((kind) => [kind, allowed])) };
      save();
    },
    forget(origin, kind) {
      if (!saved[origin]) return;
      delete saved[origin][kind];
      if (!Object.keys(saved[origin]).length) delete saved[origin];
      save();
    },
    list: () => Object.entries(saved).flatMap(([origin, kinds]) => Object.entries(kinds).map(([kind, allowed]) => ({ origin, kind, allowed }))),
  };
}

export const mediaKinds = (mediaTypes = []) => mediaTypes.map((type) => KINDS[type]).filter(Boolean);

/** Words for the prompt: "microphone", "camera", "microphone and camera". */
export const kindWords = (kinds) => kinds.join(' and ');

/**
 * Whether `origin` may have `kinds` now. A saved refusal of any kind refuses at
 * once; kinds with no saved answer are asked; the system's own grant comes last.
 */
export async function decideMedia({ origin, kinds, memory, ask, system }) {
  if (!origin || !kinds.length) return false;
  if (kinds.some((kind) => memory.get(origin, kind) === false)) return false;
  const unknown = kinds.filter((kind) => memory.get(origin, kind) === undefined);
  if (unknown.length) {
    const { allowed, remember } = await ask(origin, unknown);
    if (remember) memory.remember(origin, unknown, allowed);
    if (!allowed) return false;
  }
  for (const kind of kinds) if (!await system(kind)) return false;
  return true;
}
