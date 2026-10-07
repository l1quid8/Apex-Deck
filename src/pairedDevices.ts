// Settings → Paired devices: phones the daemon lets in from outside this
// network, what each may do, and Revoke. Pairing them (QR) comes later; for
// now `apex-daemon devices add` does it. These commands are local-only: the
// daemon refuses them from a phone.

export type Tier = "read_only" | "chat" | "full";

export interface PairedDevice {
  endpointId: string;
  label: string;
  tier: Tier;
  threads: "all" | string[];
  addedAt: number;
  lastSeen: number | null;
}

export interface DeviceRegistry {
  version: 1;
  devices: PairedDevice[];
  revoked: { endpointId: string; revokedAt: number }[];
}

export const TIERS: { id: Tier; label: string; note: string }[] = [
  { id: "read_only", label: "Read only", note: "Sees threads and their replies. Can't post or answer." },
  { id: "chat", label: "Chat and approvals", note: "Posts and answers approval cards. Posting wakes the thread's bots, which can run code on this machine, but only in threads you already set up, with the folder and permissions you gave them." },
  { id: "full", label: "Full", note: "Everything Chat can do, plus new threads, terminals, files and settings." },
];

export function devicesApi(backend: { call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }) {
  return {
    list: () => backend.call<DeviceRegistry>("devices_list", {}),
    setTier: (id: string, tier: Tier) => backend.call<PairedDevice>("devices_set_tier", { id, tier }),
    revoke: (id: string) => backend.call<null>("devices_revoke", { id }),
  };
}

export function lastSeenText(lastSeen: number | null, now = Date.now()): string {
  if (lastSeen == null) return "Never connected";
  const minutes = Math.floor((now - lastSeen) / 60_000);
  if (minutes < 1) return "Seen just now";
  if (minutes < 60) return `Seen ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Seen ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Seen ${days} ${days === 1 ? "day" : "days"} ago`;
}

export function threadsText(threads: "all" | string[]): string {
  if (threads === "all") return "All threads";
  return `${threads.length} ${threads.length === 1 ? "thread" : "threads"}`;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
