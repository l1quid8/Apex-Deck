import type { HostConnection } from "./hostConnections";
export function hostCanMutate(status: HostConnection["status"]): boolean { return status.kind === "connected"; }
