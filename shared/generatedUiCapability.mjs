// A reviewed registry entry is required. Test harness capability and renderer
// claims cannot establish a verified production build.
import policy from './generated-ui-runtime.json' with { type: 'json' };

export const GENERATED_UI_RUNTIME_POLICY = Object.freeze({
  ...policy,
  verifiedRuntimeBuilds: Object.freeze(policy.verifiedRuntimeBuilds.map(build => Object.freeze({ ...build }))),
});
const keys = ['protocolVersion', 'adapterVersion', 'securityPolicyVersion', 'electronVersion', 'chromiumVersion', 'platform', 'arch'];
export function readGeneratedUiCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return undefined;
  if (value.protocolVersion !== GENERATED_UI_RUNTIME_POLICY.protocolVersion || value.adapterVersion !== GENERATED_UI_RUNTIME_POLICY.adapterVersion
      || value.securityPolicyVersion !== GENERATED_UI_RUNTIME_POLICY.securityPolicyVersion
      || typeof value.electronVersion !== 'string' || typeof value.chromiumVersion !== 'string') return undefined;
  if (!GENERATED_UI_RUNTIME_POLICY.verifiedRuntimeBuilds.some(build => build.electronVersion === value.electronVersion
      && build.chromiumVersion === value.chromiumVersion && build.platform === value.platform && build.arch === value.arch)) return undefined;
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

/** Only trusted main's verified production metadata is sent to a daemon. */
export function clientCapabilitiesForGeneratedRuntime(result) {
  const generated_ui = result?.enabled === true ? readGeneratedUiCapability(result.guidance) : undefined;
  return generated_ui ? { generated_ui } : undefined;
}
