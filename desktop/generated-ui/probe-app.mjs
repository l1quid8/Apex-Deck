// Test-copy integrity only. Never call on an installed or production source app.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {getRawHeader} from '@electron/asar';
export function sealProbeApp(appPath) {
  if (!path.resolve(appPath).startsWith('/private/tmp/') && !path.resolve(appPath).startsWith('/tmp/')) throw Error('Probe signing requires a disposable /tmp app copy');
  const archive=path.join(appPath,'Contents/Resources/app.asar');
  const hash=createHash('sha256').update(getRawHeader(archive).headerString).digest('hex');
  execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`,path.join(appPath,'Contents/Info.plist')]);
  execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',appPath],{stdio:'pipe'});
}
