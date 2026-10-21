import UIKit
import Capacitor

@objc(CallScreenPlugin)
public class CallScreenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CallScreenPlugin"
    public let jsName = "CallScreen"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise)]
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }
}
