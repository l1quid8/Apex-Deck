// Run interactive answers in the real desktop app with an isolated host/profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';
import { EXAMPLE } from '../tests/interactive-answers-fixture.mjs';

const data = fs.mkdtempSync('/tmp/apex-answers-');
const output = path.resolve(process.env.APEX_ANSWERS_OUTPUT || '.superpowers/answers-verification');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(data, 'project'));
fs.writeFileSync(path.join(data, 'project', 'README.md'), '# Interactive answers smoke fixture\n');
fs.writeFileSync(path.join(data, 'card.json'), JSON.stringify(EXAMPLE));
// This fixture reads the real provider prompt and streams an incomplete block.
// The second bot checks the exact visible snapshot sent through normal routing.
fs.writeFileSync(path.join(data, 'fixture.mjs'), `
import fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
const mode = process.argv[2];
if (mode === 'review') {
  if (!prompt.includes('Monthly budget: $100') || !prompt.includes('Priority: Simplicity') || !prompt.includes('(v1)')) throw Error('Shared snapshot missing from provider context');
  console.log('With your shared $100 budget and Simplicity priority from v1, Serverless fits while Managed is over budget.');
} else {
  if (!prompt.includes('apex-ui')) throw Error('Card guidance was not included');
  process.stdout.write('Managed hosting is easiest at the default budget. Adjust the assumptions below.\\n\\n' + '\`\`\`apex-ui\\n{');
  await new Promise(resolve => setTimeout(resolve, 2000));
  process.stdout.write(fs.readFileSync(new URL('./card.json', import.meta.url), 'utf8').slice(1) + '\\n\`\`\`\\n');
}
`);
const env = { ...process.env, TMPDIR: '/tmp', APEX_DECK_SMOKE: '1', APEX_DECK_ANSWERS_SMOKE: '1', APEX_DECK_DATA_DIR: data, APEX_ANSWERS_OUTPUT: output };
try {
  for (const phase of ['first', 'again']) {
    const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...env, APEX_ANSWERS_PHASE: phase } });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code)); });
    clearTimeout(timer);
    assert.equal(code, 0, `answers smoke ${phase} failed; isolated data: ${data}`);
    assert.ok(fs.existsSync(path.join(output, `${phase}.json`)), `answers smoke ${phase} did not run`);
  }
  console.log(`answers smoke: both desktop launches passed; evidence ${output}`);
} finally {
  // Keep screenshots/results, but discard the test's own host and browser data.
  for (const dir of [data, `${data}-desktop`]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
