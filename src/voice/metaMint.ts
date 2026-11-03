export type MetaMint = { token: string; model: string };
export type MetaMintArgs = { room: string; participant?: string; model?: string };
type Minter = { metaSession?(args: MetaMintArgs): Promise<MetaMint> };

/** Mint a Meta ASR session token via the thread's host – same host scoping as realtime. */
export async function mintMetaForScope(
  find: (hostId: string, room: string) => Minter | undefined,
  { hostId, ...args }: MetaMintArgs & { hostId: string },
) {
  const entry = find(hostId, args.room);
  if (!entry) throw new Error("The call thread is no longer open");
  if (!entry.metaSession) throw new Error("Meta voice not available for this thread – update Deck and ensure META_API_KEY is set.");
  return entry.metaSession(args);
}
