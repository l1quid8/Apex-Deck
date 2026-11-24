import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Xcode project defines distinct Stable and Nightly configurations and shared schemes', () => {
  const pbx = read('iphone/App/App.xcodeproj/project.pbxproj');
  for (const needle of [
    'name = "Debug-Nightly";',
    'name = "Release-Nightly";',
    'APP_CHANNEL = stable;',
    'APP_CHANNEL = nightly;',
    'APP_DISPLAY_NAME = "Apex Deck";',
    'APP_DISPLAY_NAME = "Deck Nightly";',
    'APP_URL_SCHEME = apexdeck;',
    'APP_URL_SCHEME = "apexdeck-nightly";',
    'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;',
    'ASSETCATALOG_COMPILER_APPICON_NAME = AppIconNightly;',
    'PRODUCT_BUNDLE_IDENTIFIER = dev.apexdeck.phone;',
    'PRODUCT_BUNDLE_IDENTIFIER = dev.apexdeck.phone.nightly;',
  ]) {
    assert.ok(pbx.includes(needle), `project.pbxproj must include: ${needle}`);
  }

  const stableScheme = read('iphone/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme');
  const nightlyScheme = read('iphone/App/App.xcodeproj/xcshareddata/xcschemes/App Nightly.xcscheme');
  assert.ok(stableScheme.includes('buildConfiguration = "Debug"'));
  assert.ok(stableScheme.includes('buildConfiguration = "Release"'));
  assert.ok(nightlyScheme.includes('buildConfiguration = "Debug-Nightly"'));
  assert.ok(nightlyScheme.includes('buildConfiguration = "Release-Nightly"'));
});

test('Info.plist and native Swift layers separate Stable and Nightly bundle, scheme, lock, and Keychain state', () => {
  const plist = read('iphone/App/App/Info.plist');
  assert.ok(plist.includes('<key>APEXChannel</key>'));
  assert.ok(plist.includes('<string>$(APP_CHANNEL)</string>'));
  assert.ok(plist.includes('<string>$(APP_DISPLAY_NAME)</string>'));
  assert.ok(plist.includes('<string>$(APP_URL_SCHEME)</string>'));

  const lock = read('iphone/App/App/AppLock.swift');
  assert.ok(lock.includes('"dev.apexdeck.phone.nightly.lock.enabled"'));
  assert.ok(lock.includes('"dev.apexdeck.phone.lock.enabled"'));

  const scene = read('iphone/App/App/SceneDelegate.swift');
  assert.ok(scene.includes('ApexAppInfoPlugin'));
  assert.ok(scene.includes('jsName = "ApexAppInfo"'));

  const remote = read('iphone/ApexRemote/Sources/ApexRemote/ApexRemotePlugin.swift');
  assert.ok(remote.includes('"dev.apexdeck.nightly.remote.identity"'));
  assert.ok(remote.includes('"dev.apexdeck.remote.identity"'));

  const ssh = read('iphone/ApexRemote/Sources/ApexRemote/ApexSshPlugin.swift');
  assert.ok(ssh.includes('"dev.apexdeck.nightly.ssh.signin"'));
  assert.ok(ssh.includes('"dev.apexdeck.ssh.signin"'));
});

test('AppIconNightly asset exists and is distinct from Stable AppIcon', () => {
  const stableBytes = fs.readFileSync(path.join(ROOT, 'iphone/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
  const nightlyBytes = fs.readFileSync(path.join(ROOT, 'iphone/App/App/Assets.xcassets/AppIconNightly.appiconset/AppIcon-512@2x.png'));
  const contents = JSON.parse(read('iphone/App/App/Assets.xcassets/AppIconNightly.appiconset/Contents.json'));
  assert.equal(contents.images[0].filename, 'AppIcon-512@2x.png');
  assert.ok(nightlyBytes.length > 1000);
  assert.notDeepEqual(nightlyBytes, stableBytes);
});

test('iPhone CI workflow builds both Stable and Nightly schemes', () => {
  const workflow = read('.github/workflows/iphone-build.yml');
  assert.ok(workflow.includes('-scheme App'));
  assert.ok(workflow.includes('-configuration Release'));
  assert.ok(workflow.includes('-scheme "App Nightly"'));
  assert.ok(workflow.includes('-configuration Release-Nightly'));
});
