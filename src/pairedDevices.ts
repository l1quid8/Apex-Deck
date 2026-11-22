// Settings → Phones: phones the daemon lets in from outside this
// network, and Revoke. These commands are local-only: the daemon refuses them
// from a phone.

export interface PairedDevice {
  endpointId: string;
  label: string;
  addedAt: number;
  lastSeen: number | null;
}

export interface DeviceRegistry {
  version: 1;
  devices: PairedDevice[];
  revoked: { endpointId: string; revokedAt: number }[];
}

export function devicesApi(backend: Pick<import("./backend").Backend, "call">) {
  return {
    list: () => backend.call<DeviceRegistry>("devices_list", {}),
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

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
