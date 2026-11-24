import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Preload only in the CLI under test. Launch the fixture with Node directly
// so argv, environment and exit status are preserved on Windows and POSIX.
export function stubNodeCommand(directory, command, source) {
  const fixture = join(directory, command + '.cjs');
  const preload = join(directory, command + '-preload.cjs');
  writeFileSync(fixture, source);
  writeFileSync(preload, `
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;
childProcess.spawnSync = (name, args, options) => {
  if (name === ${JSON.stringify(command)}) {
    return spawnSync(process.execPath, [${JSON.stringify(fixture)}, ...args], options);
  }
  return spawnSync(name, args, options);
};
require('node:module').syncBuiltinESMExports();
`);
  return ['--require', preload];
}
