// What this fixture proves, on a real simulator build of the app: a privileged command goes to the wire
// with no prompt, and the one prompt the app has left — the lock — is the Swift plugin's own, using the
// real Face ID hardware through the same code path the product ships.
import { guardPhoneCommands } from '../../src/phone/commandGuard.ts';
import type { Transport } from '../../src/commandBackend.ts';
import { lockPresent, lockStatus, setLockEnabled, unlockApp, watchLock } from '../../src/phone/appLock.ts';

let sent = 0;
const result = document.querySelector('#result')!;
const show = (text: string) => { result.textContent = text; };
const sink: Transport = {
  async call<T>() { sent++; return undefined as T; },
  async listen() { return () => {}; },
  async saveAttachment() { throw new Error('Attachments are outside this fixture.'); },
  async readAttachment() { throw new Error('Attachments are outside this fixture.'); },
};
const guarded = guardPhoneCommands(sink);

void watchLock((status) => show(`Lock changed: ${JSON.stringify(status)}\nSent: ${sent}`));

document.querySelector('#send')!.addEventListener('click', async () => {
  // The daemon decides whether this is allowed; the phone must not stop at a prompt on the way.
  try {
    await guarded.call('room_delete', { id: 'acceptance' });
    show(`SENT with no prompt. Sent: ${sent}`);
  } catch (error) {
    show(`REFUSED before the wire. Sent: ${sent}\n${error}`);
  }
});

document.querySelector('#status')!.addEventListener('click', async () => {
  show(`Plugin: ${lockPresent() ? 'present' : 'missing'}\nStatus: ${JSON.stringify(await lockStatus())}\nSent: ${sent}`);
});

document.querySelector('#lock')!.addEventListener('click', async () => {
  const status = await setLockEnabled(true);
  show(`Lock on: ${JSON.stringify(status)}\nThe cover and the Face ID prompt should be here now.\nSent: ${sent}`);
});

document.querySelector('#unlock')!.addEventListener('click', async () => {
  show(`Unlocked: ${await unlockApp()}\nStatus: ${JSON.stringify(await lockStatus())}\nSent: ${sent}`);
});
