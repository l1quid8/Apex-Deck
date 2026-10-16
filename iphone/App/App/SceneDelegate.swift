import UIKit
import Capacitor
import ApexRemote

/// Registers the app's own native plugins, which the Capacitor CLI doesn't
/// discover because they aren't npm packages.
class AppBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ApexRemotePlugin())
        bridge?.registerPluginInstance(ApexScannerPlugin())
        bridge?.registerPluginInstance(ApexAppearancePlugin())
    }
}

/// Forward the system preference into our web-rendered glass surfaces.
@objc(ApexAppearancePlugin)
public class ApexAppearancePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApexAppearancePlugin"
    public let jsName = "ApexAppearance"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getTransparency", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(transparencyChanged),
            name: UIAccessibility.reduceTransparencyStatusDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(transparencyChanged),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc func getTransparency(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["reduced": UIAccessibility.isReduceTransparencyEnabled]) }
    }

    @objc private func transparencyChanged() {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("transparencyChanged", data: ["reduced": UIAccessibility.isReduceTransparencyEnabled])
        }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
