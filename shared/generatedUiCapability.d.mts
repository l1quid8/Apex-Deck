export interface GeneratedUiClientCapability {
  protocolVersion: 1;
  adapterVersion: string;
  securityPolicyVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  /** process.platform and process.arch of the runtime that passed the native gates. */
  platform: string;
  arch: string;
}
export interface ClientCapabilities { generated_ui: GeneratedUiClientCapability }
export interface GeneratedRuntimeCapability { enabled: boolean; reason: string; guidance?: GeneratedUiClientCapability }
export const GENERATED_UI_RUNTIME_POLICY: Readonly<{
  protocolVersion: number; adapterVersion: string; securityPolicyVersion: string;
  verifiedRuntimeBuilds: readonly Readonly<{ electronVersion: string; chromiumVersion: string; platform: string; arch: string }>[];
}>;
export function readGeneratedUiCapability(value: unknown): GeneratedUiClientCapability | undefined;
export function clientCapabilitiesForGeneratedRuntime(value: unknown): ClientCapabilities | undefined;
