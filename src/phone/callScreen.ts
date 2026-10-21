import { Capacitor, registerPlugin } from "@capacitor/core";
const CallScreen = registerPlugin<{
  keepAwake(options: { on: boolean }): Promise<void>;
}>("CallScreen");
export function keepAwake(on: boolean): void {
  if (Capacitor.isPluginAvailable("CallScreen"))
    void CallScreen.keepAwake({ on }).catch(() => {});
}
