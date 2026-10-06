import type { TurnPolicy } from "./types";

export const REPLY_POLICIES: { value: TurnPolicy; label: string }[] = [
  { value: "mention", label: "Whoever I addressed last" },
  { value: "everyone", label: "Everyone at once" },
  { value: "round_robin", label: "Everyone in turn" },
];

