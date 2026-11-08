import catalog from '../shared/composer-commands.json' with { type: 'json' };
import type { Command } from './commands.ts';

/** Shared metadata; each client retains typed dispatch for its own surface. */
export const composerCommandRegistry = catalog;
export const appComposerCommands = catalog.filter(row => row.surfaces.includes('app')).map(row => ({
  kind: 'command' as const, key: row.key, label: row.label, detail: row.detail,
  command: (row.appCommand ?? null) as Command | null,
}));
export function appCommandName(name: string): boolean {
  return catalog.some(row => row.surfaces.includes('app') && row.key.split(' ')[0] === name);
}
