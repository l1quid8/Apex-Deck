import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";

import "../styles.css";
import { PhoneApp } from "./PhoneApp";
// Phone overrides follow the shared components' styles in both dev and bundled builds.
import "./phone.css";

const root = document.documentElement;
const view = window.visualViewport;

if (Capacitor.isPluginAvailable("Keyboard")) {
  // In the iPhone app the web view is the screen's root view, so iOS resets
  // any size the Keyboard plugin gives it ("native" resize never stuck, and
  // the keyboard covered the composer). capacitor.config.json sets resize
  // "none" and the app shortens itself by the height the plugin reports,
  // which also tells the tabs when to step aside. No Previous/Next/Done bar
  // over the keyboard, as in Messages.
  const fit = (keyboard: number) => {
    if (keyboard > 0) root.style.setProperty("--ph-height", `${window.innerHeight - keyboard}px`);
    else root.style.removeProperty("--ph-height");
    root.toggleAttribute("data-keyboard", keyboard > 0);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  void Keyboard.setAccessoryBarVisible({ isVisible: false });
  void Keyboard.addListener("keyboardWillShow", (info) => fit(info.keyboardHeight));
  void Keyboard.addListener("keyboardDidShow", (info) => fit(info.keyboardHeight));
  void Keyboard.addListener("keyboardWillHide", () => fit(0));
  // WKWebView may still nudge the page up to reveal the focused box.
  window.addEventListener("scroll", () => {
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  });
} else if (view) {
  // In Safari the keyboard is laid over the page instead of shrinking it.
  // Keep the app the height that's still visible, so the composer sits on
  // top of the keyboard.
  const fit = () => {
    root.style.setProperty("--ph-height", `${view.height}px`);
    root.toggleAttribute("data-keyboard", window.innerHeight - view.height > 120);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  view.addEventListener("resize", fit);
  view.addEventListener("scroll", fit);
  fit();
}

createRoot(document.getElementById("root")!).render(<PhoneApp />);
