// Gateway management is only exposed by the local desktop backend. The daemon
// independently rejects every management request from Device and Token trust.
export type GatewayScope = 'sub' | 'api' | 'cli';
export interface GatewayKey {
  id: string; label: string; prefix: string; scopes: GatewayScope[];
  max_turns_per_day: number | null; max_usd_micros_per_month: number | null;
  turns_today: number; spend_micros_month: number; last_used_at: number | null; created_at: number;
}
export interface GatewayStatus { enabled: boolean; bind: string; port: number; baseUrl: string | null; error?: string | null }
export interface GatewayProvider { id: string; name: string; kind: string; available: boolean; detail: string }
export interface GatewayIssue { label: string; scopes: GatewayScope[]; allowMcp: false; maxTurnsPerDay: number | null; maxUsdMicrosPerMonth: number | null }
export interface GatewayIssued { token: string; key: GatewayKey }
type Owner = { demo: boolean; gatewayAdmin?: boolean; host?: { id: string } };
type Caller = Owner & { call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
export function gatewayOwner(backend: Owner): boolean {
  return !backend.demo && backend.gatewayAdmin === true && backend.host?.id === 'local';
}
export function issueGatewaySpec(label: string, scope: string, daily: string, usd: string): GatewayIssue {
  const name = label.trim();
  if (!name || name.length > 60) throw new Error('Enter a key label from 1 to 60 characters.');
  const scopes: GatewayScope[] = scope === 'all' ? ['sub','api','cli'] : scope === 'api' ? ['api'] : scope === 'sub' ? ['sub'] : [];
  if (!scopes.length) throw new Error('Choose a model scope.');
  const turns = daily.trim() ? Number(daily) : null;
  const budget = usd.trim() ? Number(usd) : null;
  if (turns !== null && (!Number.isSafeInteger(turns) || turns < 1 || turns > 10000)) throw new Error('Daily requests must be a whole number from 1 to 10,000, or blank for unlimited.');
  if (budget !== null && (!Number.isFinite(budget) || budget < 0.01 || budget > 1000000)) throw new Error('Spend cap must be $0.01 to $1,000,000, or blank for unlimited.');
  return {label:name, scopes, allowMcp:false, maxTurnsPerDay:turns, maxUsdMicrosPerMonth:budget === null ? null : Math.round(budget * 1000000)};
}
export function gatewayApi(backend: Caller) {
  const call = <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => gatewayOwner(backend)
    ? backend.call<T>(cmd, args) : Promise.reject(new Error('Only the local host owner can manage the model gateway.'));
  return {
    status: () => call<GatewayStatus>('gateway_status'),
    providers: () => call<{ providers: GatewayProvider[] }>('gateway_providers'),
    list: () => call<{ keys: GatewayKey[] }>('gateway_keys_list'),
    issue: (spec: GatewayIssue) => call<GatewayIssued>('gateway_keys_issue', {...spec, allowMcp:false}),
    revoke: (id: string) => call<{revoked: boolean}>('gateway_keys_revoke', {id}),
    configure: (config: Pick<GatewayStatus, 'enabled'|'bind'|'port'>) => call<GatewayStatus>('gateway_configure', {...config}),
  };
}
