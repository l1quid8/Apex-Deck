import { guardPhoneCommands } from '../../src/phone/commandGuard.ts';
import type { Transport } from '../../src/commandBackend.ts';

let sent = 0;
let attempt = 0;
const result = document.querySelector('#result')!;
const sink: Transport = {
  async call<T>() { sent++; return undefined as T; },
  async listen() { return () => {}; },
  async saveAttachment() { throw new Error('Attachments are outside this fixture.'); },
  async readAttachment() { throw new Error('Attachments are outside this fixture.'); },
};
const guarded = guardPhoneCommands(sink, 'Acceptance sink');
document.querySelector('#raise')!.addEventListener('click', async () => {
  const own = ++attempt;
  result.textContent = `Attempt ${own} pending. Sent: ${sent}`;
  try {
    await guarded.call('folder_accept', { folder: '/acceptance' });
    result.textContent = `Attempt ${own} AUTHENTICATED. Sent: ${sent}`;
  } catch (error) {
    result.textContent = `Attempt ${own} BLOCKED. Sent: ${sent}\n${error}`;
  }
});
