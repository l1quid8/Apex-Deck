// Apply the display-aware transport to a running Deck's pinned AXe entrypoint.
// Keeps the original executable beside it; no daemon/app restart or build replacement.
// Usage: node scripts/install-phone-screen-bridge.mjs DATA_DIR UDID BUILT_BRIDGE
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [dataArg,udid,binaryArg] = process.argv.slice(2);
if (!dataArg || !binaryArg || !/^[A-Fa-f0-9-]{36}$/.test(udid ?? '')) throw new Error('Expected DATA_DIR UDID BUILT_BRIDGE');
const data = path.resolve(dataArg);
const saved = JSON.parse(await fs.readFile(path.join(data,'phone','device.json'),'utf8'));
if (saved.udid !== udid) throw new Error('The UDID must be this data folder’s shared phone.');
const dir = path.join(data,'tools','axe-1.8.0');
const axe = path.join(dir,'axe');
const configPath = path.join(dir,'deck-screen-bridge.json');
const binary = path.resolve(binaryArg);
await fs.access(binary);
const source = new URL('../crates/apex-host/src/phone/touch.m',import.meta.url);
const touchSource = path.join(dir,'deck-touch.m');
const touch = path.join(dir,'deck-touch');
await fs.copyFile(source,touchSource);
execFileSync('/usr/bin/xcrun',['clang','-fobjc-arc','-fblocks','-framework','Foundation',touchSource,'-o',touch+'.part']);
await fs.rename(touch+'.part',touch);
const developer = execFileSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8'}).trim();
let config;
try { config = JSON.parse(await fs.readFile(configPath,'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
let legacy = config?.legacy;
if (legacy) {
  if (config.data !== data || config.udid !== udid) throw new Error('Existing bridge belongs to another phone.');
  await fs.access(legacy);
} else {
  const original = await fs.readFile(axe);
  const hash = crypto.createHash('sha256').update(original).digest('hex');
  legacy = path.join(dir,`axe-preserved-${hash.slice(0,16)}`);
  try { await fs.access(legacy); throw new Error('Preserved AXe already exists without a bridge config; inspect it first.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.copyFile(axe,legacy,fs.constants.COPYFILE_EXCL);
  await fs.chmod(legacy,0o755);
}
await fs.copyFile(binary,axe+'.part');
await fs.chmod(axe+'.part',0o755);
await fs.writeFile(configPath+'.part',JSON.stringify({data,udid,legacy,touch,developer},null,2)+'\n',{mode:0o600});
await fs.rename(configPath+'.part',configPath);
await fs.rename(axe+'.part',axe);
console.log(`Installed display bridge for ${udid}. Original AXe preserved at ${legacy}.`);
console.log('The running stream must reconnect once. The daemon and chats stay running.');
