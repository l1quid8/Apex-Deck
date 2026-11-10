import UIKit
import Capacitor
import ApexRemote

/// Registers the app's own native plugins, which the Capacitor CLI doesn't
/// discover because they aren't npm packages.
class AppBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ApexRemotePlugin())
        bridge?.registerPluginInstance(ApexSshPlugin())
        bridge?.registerPluginInstance(ApexScannerPlugin())
        bridge?.registerPluginInstance(ApexAppearancePlugin())
        bridge?.registerPluginInstance(AppLockPlugin())
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

        // The lock draws its cover in this window, so it needs the window before the first frame.
        AppLock.shared.window = window
        AppLock.shared.started()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // MARK: - The app lock. These fire before the app-switcher snapshot and before any prompt could
    // be shown outside the foreground, so the cover is up in time and the asking is left until the
    // app is active again.
    func sceneWillResignActive(_ scene: UIScene) {
        AppLock.shared.willResignActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        AppLock.shared.didEnterBackground()
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        AppLock.shared.willEnterForeground()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        AppLock.shared.didBecomeActive()
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        if AppLock.shared.window === window { AppLock.shared.window = nil }
    }
}
