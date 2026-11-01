export type RealtimeMint = { client_secret: string; expires_at?: number; model: string; voice: string };
export type RealtimeMintArgs = { room: string; participant?: string; model?: string; voice?: string; instructions?: string; tools?: unknown[] };
type Minter = { realtimeSession?(args: RealtimeMintArgs): Promise<RealtimeMint> };

/** The session is minted by the machine that owns the call's thread, so the same
 * id on another host can never answer for it. */
export async function mintForScope(find: (hostId: string, room: string) => Minter | undefined, { hostId, ...args }: RealtimeMintArgs & { hostId: string }) {
  const entry = find(hostId, args.room);
  if (!entry) throw new Error("The call thread is no longer open");
  if (!entry.realtimeSession) throw new Error("Realtime not available for this thread – update Deck and ensure OPENAI_API_KEY is set.");
  return entry.realtimeSession(args);
}
