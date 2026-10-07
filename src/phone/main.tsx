import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";

import "../styles.css";
import "./phone.css";
import { PhoneApp } from "./PhoneApp";

const root = document.documentElement;
const view = window.visualViewport;

if (Capacitor.isPluginAvailable("Keyboard")) {
  // In the iPhone app the Keyboard plugin shrinks the web view itself to end
  // at the keyboard (capacitor.config.json: resize "native"), so the
  // composer's 100% height already sits on top of it. The plugin also says
  // when the keyboard comes and goes, so the tabs can step aside. No
  // Previous/Next/Done bar over the keyboard, as in Messages.
  void Keyboard.setAccessoryBarVisible({ isVisible: false });
  void Keyboard.addListener("keyboardWillShow", () => root.toggleAttribute("data-keyboard", true));
  void Keyboard.addListener("keyboardWillHide", () => root.toggleAttribute("data-keyboard", false));
  void Keyboard.addListener("keyboardDidShow", () => {
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
