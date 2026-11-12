import SwiftUI
import WebKit
import LocalAuthentication

// CryptoPal on iPhone: the live CryptoPal web app in a full-screen view.
// Every update to the website shows up here the next time the app opens.
// The face check and face data stay on this phone (inside this app's storage).
// Michael's demo session, so the phone app and the computer demo (register, Ana, demo panel) are the same world.
let startURL = URL(string: "https://cryptopal.michaelwilson260.workers.dev/?w=482acf09-eac8-43e2-8067-6cc840072b33")!

// Holds the one web view so links and QR codes can open inside it.
final class Web: ObservableObject {
  weak var view: WKWebView?
  var pending: URL?
  // A CryptoPal link (from a QR code, the Action Button Shortcut, or a message) opens here, not in Safari.
  func open(_ url: URL) {
    guard url.host == startURL.host else { return }
    if let v = view { v.load(URLRequest(url: url)) } else { pending = url }
  }
}

@main
struct CryptoPalApp: App {
  @StateObject private var web = Web()
  var body: some Scene {
    WindowGroup {
      CryptoPalView(web: web)
        .ignoresSafeArea()
        .onOpenURL { web.open($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { a in if let u = a.webpageURL { web.open(u) } }
        .background(Color(red: 7 / 255, green: 7 / 255, blue: 12 / 255))
        .preferredColorScheme(.dark)
    }
  }
}

struct CryptoPalView: UIViewRepresentable {
  let web: Web
  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true                 // the camera shows inside the page
    config.mediaTypesRequiringUserActionForPlayback = []
    config.websiteDataStore = .default()                    // keeps your saved face and session on this phone
    config.userContentController.add(context.coordinator, name: "cp") // the page can ask for iPhone Face ID
    let web = WKWebView(frame: .zero, configuration: config)
    web.uiDelegate = context.coordinator
    web.navigationDelegate = context.coordinator
    web.isOpaque = false
    web.backgroundColor = UIColor(red: 7 / 255, green: 7 / 255, blue: 12 / 255, alpha: 1)
    web.scrollView.backgroundColor = web.backgroundColor
    web.scrollView.contentInsetAdjustmentBehavior = .never
    web.allowsBackForwardNavigationGestures = false
    // Open where you left off (your demo session), or the start page the first time.
    let last = UserDefaults.standard.url(forKey: "lastURL")
    web.load(URLRequest(url: self.web.pending ?? last ?? startURL))
    self.web.view = web; self.web.pending = nil
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    // iPhone Face ID when you pay. The answer goes back to the page (true = it's you).
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
      guard let body = message.body as? [String: Any], body["type"] as? String == "faceid",
            let id = body["id"] as? String, let web = message.webView else { return }
      let ctx = LAContext()
      var e: NSError?
      let policy: LAPolicy = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e) ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication
      ctx.evaluatePolicy(policy, localizedReason: "Confirm it's you to pay with CryptoPal") { ok, _ in
        DispatchQueue.main.async {
          let safe = id.filter { $0.isLetter || $0.isNumber }
          web.evaluateJavaScript("window.__cpNative && window.__cpNative('\(safe)', \(ok))")
        }
      }
    }
    // Camera and microphone: the app already asked iPhone for permission, so the page can use them.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
      decisionHandler(origin.host == startURL.host ? .grant : .prompt)
    }
    // Pop-ups (like PayPal) open in the same view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
      if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
      return nil
    }
    // Remember the CryptoPal page you were on (it holds your demo session).
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      if let u = webView.url, u.host == startURL.host { UserDefaults.standard.set(u, forKey: "lastURL") }
    }
    // Simple alerts and "Are you sure?" questions from the page.
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
      let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
      a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
      a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
      top()?.present(a, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
      let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
      a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
      top()?.present(a, animated: true)
    }
    private func top() -> UIViewController? {
      (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.windows.first?.rootViewController
    }
  }
}
