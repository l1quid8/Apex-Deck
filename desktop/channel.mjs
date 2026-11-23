import { checkedChannel, nightlyIdentity } from "./channelIdentity.mjs";
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const readJson = url => JSON.parse(readFileSync(url, 'utf8'));
const identities = readJson(new URL('./channels.json', import.meta.url));

export function loadChannel({ packaged, env, readStamp }) {
  const stamp = packaged ? readStamp() : { channel: env.APEX_CHANNEL ?? 'stable' };
  const name = checkedChannel(stamp.channel);
  const nightly = name === 'nightly';
  const build = nightly && packaged ? nightlyIdentity(stamp) : {};
  return Object.freeze({ ...identities[name], name, nightly, ...build });
}

export const packaged = process.versions.electron
  ? createRequire(import.meta.url)('electron').app.isPackaged : false;
export const channel = loadChannel({
  packaged, env: process.env,
  readStamp: () => readJson(new URL('../dist/channel.json', import.meta.url)),
});
