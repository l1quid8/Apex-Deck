import type { Backend } from "../backend.ts";
export async function postFromPhone(
  backend: Pick<Backend, "roomPostTo">,
  paneId: string,
  text: string,
  to: string[],
  manual: boolean | undefined,
  voice?: { requestId: string },
): Promise<void> {
  if (voice)
    await backend.roomPostTo(paneId, text, to, false, false, {
      client_turn_id: voice.requestId,
      max_bot_hops: 0,
    });
  else await backend.roomPostTo(paneId, text, to, !manual);
}
