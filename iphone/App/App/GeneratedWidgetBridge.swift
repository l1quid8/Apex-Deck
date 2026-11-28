import WebKit

let widgetWorld = WKContentWorld.world(name: "ApexWidgetHost")

/// The page-world adapter exists only in the trusted top frame. The generated
/// document has an opaque sandbox origin and cannot dispatch DOM events there.
let topBridge = """
window.generatedUIHost = Object.freeze({
    postMessage(message) {
        if (message.type === 'widget-state') {
            message = {...message, widgetState: JSON.stringify(message.widgetState)};
        }
        document.dispatchEvent(new CustomEvent('apex-widget-event', {detail: JSON.stringify(message)}));
    },
    onCommand(receive) { window.apexWidgetCommand = receive; }
});
"""

let isolatedBridge = """
document.addEventListener('apex-widget-event', event => {
    if (typeof event.detail === 'string' && event.detail.length <= 16384)
        window.webkit.messageHandlers.widget.postMessage(event.detail);
});
"""

/// CSP covers fetches and subresources. Remove WebRTC (including its prefixed
/// constructor), local-device and permission interfaces from every frame before
/// any author script runs. Throwing during installation prevents initialization.
let webKitGuards = """
(() => {
    const seal = (target, name) => Object.defineProperty(target, name,
        {value: undefined, configurable: false, writable: false});
    for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCIceGatherer',
        'WebTransport','WebSocket','WebSocketStream','EventSource','Worker','SharedWorker',
        'BroadcastChannel','PaymentRequest','Notification','DeviceMotionEvent','DeviceOrientationEvent'])
        seal(window, name);
    for (const name of ['clipboard','geolocation','permissions','credentials','serviceWorker',
        'share','getUserMedia','webkitGetUserMedia','sendBeacon'])
        seal(Navigator.prototype, name);
    window.__apexWidgetGuardsReady = true;
})();
"""

@MainActor func installWidgetBridge(in controller: WKUserContentController, handler: WKScriptMessageHandler) {
    controller.addUserScript(WKUserScript(source: webKitGuards, injectionTime: .atDocumentStart,
                                          forMainFrameOnly: false, in: .page))
    controller.addUserScript(WKUserScript(source: topBridge, injectionTime: .atDocumentStart,
                                          forMainFrameOnly: true, in: .page))
    controller.addUserScript(WKUserScript(source: isolatedBridge, injectionTime: .atDocumentStart,
                                          forMainFrameOnly: true, in: widgetWorld))
    // Only the isolated world can identify the sandbox frame to native.
    let identify = "if (window !== top && location.href === 'about:srcdoc') window.webkit.messageHandlers.widget.postMessage('snapshot-frame');"
    controller.addUserScript(WKUserScript(source: identify, injectionTime: .atDocumentStart,
                                          forMainFrameOnly: false, in: widgetWorld))
    controller.add(handler, contentWorld: widgetWorld, name: "widget")
}
