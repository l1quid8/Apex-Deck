// Settings → Remote access: save the switch and restart the daemon with it.
// A daemon that won't start with the new setting (built without the
// `remote` feature, a port it can't bind) must not leave the app without
// one on every launch, so the old setting is saved back and started again.

const words = (error) => String(error instanceof Error ? error.message : error).trim();
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Move from `from` to `to`: `save` it, `set` it for the next start, then
 * `restart`. Resolves with what `restart` gave. On failure, saves and sets
 * `from` again, restarts with it, and rejects with the daemon's words.
 */
export async function changeRemoteAccess({ from, to, save, set, restart }) {
  save(to);
  set(to);
  try {
    return await restart();
  } catch (error) {
    save(from);
    set(from);
    const first = `Couldn't turn Remote access ${to ? 'on' : 'off'}: ${sentence(words(error))} It was left ${from ? 'on' : 'off'}.`;
    try {
      await restart();
    } catch (again) {
      throw new Error(`${first} The background service didn't start again either: ${sentence(words(again))}`);
    }
    throw new Error(first);
  }
}
