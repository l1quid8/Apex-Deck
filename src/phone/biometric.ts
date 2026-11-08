// Phone-local authentication only. The daemon independently checks device
// authority; a phone authentication result is never sent as proof to the host.
import { Capacitor, registerPlugin } from "@capacitor/core";

interface BiometricNative {
  authenticateBiometric(options: { reason: string }): Promise<{ authenticated: boolean }>;
}

let native: BiometricNative | undefined;

/** No browser confirmation, passcode policy, or saved SSH-secret fallback. */
export async function requireFaceId(reason: string): Promise<boolean> {
  try {
    if (!Capacitor.isPluginAvailable("ApexSsh")) return false;
    native ??= registerPlugin<BiometricNative>("ApexSsh");
    return (await native.authenticateBiometric({ reason })).authenticated === true;
  } catch {
    return false;
  }
}

export async function confirmFullAccessRaise(action: string): Promise<boolean> {
  return requireFaceId(`Raising to Full lets this device ${action}. Confirm with biometrics.`);
}
