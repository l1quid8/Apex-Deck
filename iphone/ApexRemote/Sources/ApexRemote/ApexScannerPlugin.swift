import Foundation
import AVFoundation
import UIKit
import Capacitor

/// Scans one QR code with the camera (AVFoundation, no third-party code) and
/// resolves `{text}`, or rejects "cancelled" or "denied".
@objc(ApexScannerPlugin)
public class ApexScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApexScannerPlugin"
    public let jsName = "ApexScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("no_view_controller")
                return
            }
            // Every way out (scan, Cancel, swipe down, no camera) answers the call once.
            let scanVC = QRScanViewController { result in
                switch result {
                case .success(let text): call.resolve(["text": text])
                case .cancelled: call.reject("cancelled")
                case .denied: call.reject("denied")
                case .error(let error): call.reject(error)
                }
            }
            presenter.present(scanVC, animated: true)
        }
    }
}

private enum ScanResult {
    case success(String)
    case cancelled
    case denied
    case error(String)
}

private class QRScanViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let answer: (ScanResult) -> Void
    private var answered = false
    private var hasScanned = false
    private let sessionQueue = DispatchQueue(label: "dev.apexdeck.scanner.session")

    init(completion: @escaping (ScanResult) -> Void) {
        self.answer = completion
        super.init(nibName: nil, bundle: nil)
    }

    /// Answers at most once, on the main thread.
    private func completion(_ result: ScanResult) {
        guard !answered else { return }
        answered = true
        answer(result)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Swiped down without scanning.
        completion(.cancelled)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        // Check camera permission
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            setupCamera()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.setupCamera()
                    } else {
                        self?.completion(.denied)
                        self?.dismiss(animated: true)
                    }
                }
            }
        case .denied, .restricted:
            // Not on screen yet; answer now and leave once presented.
            completion(.denied)
            DispatchQueue.main.async { self.dismiss(animated: true) }
        @unknown default:
            completion(.denied)
            dismiss(animated: true)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = captureSession
        sessionQueue.async { if session.isRunning { session.stopRunning() } }
    }

    private func setupCamera() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            completion(.error("no_camera"))
            dismiss(animated: true)
            return
        }

        do {
            let input = try AVCaptureDeviceInput(device: device)
            let output = AVCaptureMetadataOutput()
            guard captureSession.canAddInput(input), captureSession.canAddOutput(output) else {
                completion(.error("camera_unavailable"))
                dismiss(animated: true)
                return
            }
            captureSession.addInput(input)
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
            output.metadataObjectTypes = [.qr]

            previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
            if let previewLayer = previewLayer {
                previewLayer.frame = view.bounds
                previewLayer.videoGravity = .resizeAspectFill
                view.layer.addSublayer(previewLayer)
            }

            addCloseButton()

            // startRunning blocks, so it stays off the main thread.
            let session = captureSession
            sessionQueue.async { session.startRunning() }
        } catch {
            completion(.error(error.localizedDescription))
            dismiss(animated: true)
        }
    }

    private func addCloseButton() {
        let button = UIButton(type: .system)
        button.setTitle("Cancel", for: .normal)
        button.tintColor = .white
        button.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        button.layer.cornerRadius = 10
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addTarget(self, action: #selector(closeButtonTapped), for: .touchUpInside)

        view.addSubview(button)

        NSLayoutConstraint.activate([
            button.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
            button.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            button.widthAnchor.constraint(equalToConstant: 100),
            button.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    @objc private func closeButtonTapped() {
        completion(.cancelled)
        dismiss(animated: true)
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasScanned else { return }

        for metadata in metadataObjects {
            guard let readableObject = metadata as? AVMetadataMachineReadableCodeObject else { continue }
            guard readableObject.type == .qr else { continue }
            guard let stringValue = readableObject.stringValue else { continue }

            hasScanned = true
            let session = captureSession
            sessionQueue.async { session.stopRunning() }
            completion(.success(stringValue))
            dismiss(animated: true)
            return
        }
    }
}
