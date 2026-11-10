import UIKit
import LocalAuthentication
import Capacitor

/// Apex Deck's one lock.
///
/// The app used to ask Face ID before individual commands (saving the thread list, adding a bot to a
/// thread, deleting a thread). That was removed by request: the machine already decides what a paired
/// phone may do — apex-daemon classifies every command and refuses what the device's level doesn't
/// cover — and a prompt that is answered on the phone proves nothing to the machine. So the asking
/// moved here, to one lock on the whole app: Face ID when it opens, and again after it has been out of
/// sight for a minute or more.
///
/// What this class does, in the order iOS calls it:
///  - `willResignActive`: put an opaque cover over the window straight away, so the app switcher's
///    snapshot shows a lock and not the thread someone was reading.
///  - `didEnterBackground`: start the clock.
///  - `willEnterForeground`: past the grace period, lock — the cover stays and the prompt comes when
///    the app is active again.
///  - `didBecomeActive`: ask, or lift the cover if this was only a quick trip to another app.
///
/// Face ID falls back to the iPhone passcode, because a failed scan must not shut someone out of their
/// own app. A device with no passcode cannot be locked at all; `available` reports that rather than
/// trapping the user behind a cover nothing can open.
final class AppLock {
    static let shared = AppLock()

    /// How long the app may be in the background before it locks again.
    static let grace: TimeInterval = 60
    /// A successful unlock is not immediately undone by the scene notices the Face ID sheet itself sends.
    private static let settle: TimeInterval = 2
    private static let enabledKey = "dev.apexdeck.phone.lock.enabled"

    weak var window: UIWindow?
    private(set) var locked = false
    private var cover: UIView?
    private var leftAt: Date?
    private var unlockedAt: Date?
    private var asking = false
    /// Set by the plugin, so a change in Settings reaches the screen without polling.
    var changed: (() -> Void)?

    private var defaults: UserDefaults { .standard }

    init() {
        defaults.register(defaults: [AppLock.enabledKey: true])
    }

    /// What Settings shows, and what the plugin reports.
    var enabled: Bool { defaults.object(forKey: AppLock.enabledKey) as? Bool ?? true }

    /// A passcode (with or without Face ID) is what makes a lock possible at all.
    var available: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }

    var status: [String: Bool] { ["enabled": enabled, "locked": locked, "available": available] }

    // MARK: - Settings

    @discardableResult
    func setEnabled(_ on: Bool) -> Bool {
        defaults.set(on, forKey: AppLock.enabledKey)
        if on && available { lock() } else { unlock() }
        changed?()
        return enabled
    }

    // MARK: - Lifecycle, called by SceneDelegate

    /// Launch: a locked app from the first frame, so nothing is readable behind the prompt.
    func started() {
        guard enabled, available else { return }
        lock()
    }

    func willResignActive() {
        // Opaque, and up before iOS takes its snapshot for the app switcher.
        showCover()
    }

    func didEnterBackground() {
        leftAt = Date()
    }

    func willEnterForeground() {
        guard enabled, available, let leftAt else { return }
        guard Date().timeIntervalSince(leftAt) >= AppLock.grace else { return }
        lock()
    }

    func didBecomeActive() {
        if locked {
            if let unlockedAt, Date().timeIntervalSince(unlockedAt) < AppLock.settle {
                // The biometric sheet's own resign/become cycle, just after a successful unlock.
                hideCover()
                return
            }
            showCover()
            ask()
            return
        }
        hideCover()
    }

    // MARK: - Locking

    func lock() {
        locked = true
        showCover()
        changed?()
        if window != nil, window?.windowScene?.activationState == .foregroundActive { ask() }
    }

    func unlock() {
        locked = false
        unlockedAt = Date()
        hideCover()
        changed?()
    }

    /// Ask for Face ID, the passcode, or nothing — never twice at once.
    func ask(_ done: ((Bool) -> Void)? = nil) {
        guard locked, available, !asking else { done?(false); return }
        asking = true
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        context.localizedFallbackTitle = "Use Passcode"
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Apex Deck") { [weak self] success, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self else { done?(false); return }
                self.asking = false
                // Only a result for an app still in front may open it: an unlock that finished while
                // the app was in the background would otherwise leave the next launch unlocked.
                guard success, self.window?.windowScene?.activationState != .background else {
                    self.showRetry()
                    self.changed?()
                    done?(false)
                    return
                }
                self.unlock()
                done?(true)
            }
        }
    }

    /// The plugin's own unlock (the switch in Settings, or a retry from the cover).
    func requestUnlock(_ done: @escaping (Bool) -> Void) {
        guard enabled, available else {
            // A phone with no passcode cannot be locked, so there is nothing to ask and nothing to hold.
            locked = false
            hideCover()
            changed?()
            return done(true)
        }
        if !locked { return done(true) }
        ask(done)
    }

    // MARK: - The cover

    private func showCover() {
        guard let window else { return }
        if let cover, cover.superview === window { return }
        let cover = cover ?? makeCover()
        cover.frame = window.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(cover)
        cover.alpha = 1
        self.cover = cover
        setRetryVisible()
    }

    private func hideCover() {
        cover?.removeFromSuperview()
    }

    /// After a cancelled or failed attempt: say so, and leave a way back in.
    private func showRetry() {
        guard locked else { return }
        showCover()
        setRetryVisible()
    }

    private var retry: UIButton?
    private var note: UILabel?

    private func setRetryVisible() {
        retry?.isHidden = !(locked && available && !asking)
        note?.text = locked && !available
            ? "Apex Deck can't lock without a passcode on this iPhone."
            : "Locked"
    }

    private func makeCover() -> UIView {
        let view = UIView()
        view.backgroundColor = UIColor(red: 0.035, green: 0.051, blue: 0.071, alpha: 1) // the app's own #090d12
        view.isUserInteractionEnabled = true
        view.accessibilityViewIsModal = true
        view.accessibilityLabel = "Apex Deck is locked"

        let icon = UIImageView(image: UIImage(systemName: "lock.fill"))
        icon.tintColor = UIColor(red: 0.35, green: 0.85, blue: 0.69, alpha: 1)  // mint, as in the app
        icon.contentMode = .scaleAspectFit
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 34).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 34).isActive = true

        let title = UILabel()
        title.text = "Apex Deck"
        title.textColor = .white
        title.font = .systemFont(ofSize: 20, weight: .semibold)

        let note = UILabel()
        note.text = "Locked"
        note.textColor = .secondaryLabel
        note.font = .preferredFont(forTextStyle: .subheadline)
        note.numberOfLines = 0
        note.textAlignment = .center
        self.note = note

        let retry = UIButton(type: .system)
        retry.setTitle("Unlock", for: .normal)
        retry.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        retry.addTarget(self, action: #selector(unlockTapped), for: .touchUpInside)
        retry.isHidden = true
        self.retry = retry

        let stack = UIStackView(arrangedSubviews: [icon, title, note, retry])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
        ])
        return view
    }

    @objc private func unlockTapped() {
        ask()
    }
}

/// The few things the web app needs to say to the lock: is it on, turn it on or off, and unlock.
@objc(AppLockPlugin)
public class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "ApexLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        AppLock.shared.changed = { [weak self] in
            DispatchQueue.main.async { self?.notifyListeners("lockChanged", data: AppLock.shared.status) }
        }
    }

    deinit { AppLock.shared.changed = nil }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(AppLock.shared.status) }
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        guard call.hasOption("enabled") else { return call.reject("Missing enabled.") }
        DispatchQueue.main.async {
            let on = call.getBool("enabled") ?? true
            call.resolve(["enabled": AppLock.shared.setEnabled(on), "available": AppLock.shared.available])
        }
    }

    @objc func unlock(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AppLock.shared.requestUnlock { unlocked in
                call.resolve(["unlocked": unlocked, "locked": AppLock.shared.locked])
            }
        }
    }
}
