// electron-builder signs Apex Deck.exe itself, but not programs copied in through
// extraResources, so the service and its helper are signed here.
const { join } = require('node:path');

exports.default = async function signWindowsResources({ appOutDir, electronPlatformName, packager }) {
  if (electronPlatformName !== 'win32' || process.env.APEX_DECK_WIN_SIGN !== '1') return;
  for (const name of ['apex-daemon.exe', 'apex-provenance.exe']) {
    await packager.signIf(join(appOutDir, 'resources', 'bin', name));
  }
};
