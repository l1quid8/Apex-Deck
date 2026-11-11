/** Where you were reading a thread: the reply at the top of the screen and how far into it you were. */
export type ReadingPlace = { seq: number; gap: number };

/**
 * Where a thread opens. Back at the reply you were reading when it is there; "wait" while the
 * thread's replies are still loading and that one hasn't arrived yet; otherwise at the newest message.
 * There is no answer that leaves the thread where the screen happened to be, which was the top.
 */
export function placeToRestore(kept: ReadingPlace | undefined, seqs: readonly number[]): ReadingPlace | "wait" | "end" {
  if (!kept) return "end";
  if (seqs.includes(kept.seq)) return kept;
  // A later reply is already here, so that one is gone (taken back, or no longer in the thread).
  return seqs.some((seq) => seq > kept.seq) ? "end" : "wait";
}
