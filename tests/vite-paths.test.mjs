import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

test('Vite entry paths decode spaces in bot-copy directories', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck config spaces '));
  try {
    fs.copyFileSync(new URL('../vite.config.ts', import.meta.url), path.join(temp, 'vite.config.ts'));
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({type:'module',version:'0.0.0'}));
    fs.symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(temp, 'node_modules'), 'dir');
    for (const name of ['index.html','phone.html']) fs.writeFileSync(path.join(temp,name), '<div></div>');
    const {default: config} = await import(pathToFileURL(path.join(temp, 'vite.config.ts')).href);
    assert.equal(config.build.rolldownOptions.input.main, fs.realpathSync(path.join(temp, 'index.html')));
    assert.equal(config.build.rolldownOptions.input.phone, fs.realpathSync(path.join(temp, 'phone.html')));
  } finally {
    fs.rmSync(temp, {recursive:true,force:true});
  }
});
