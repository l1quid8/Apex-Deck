import { createRoot } from "react-dom/client";

import "../styles.css";
import "./phone.css";
import { PhoneApp } from "./PhoneApp";

// iOS lays the keyboard over the page instead of shrinking it. Keep the app
// the height that's still visible, so the composer sits on top of the
// keyboard, and say when the keyboard is up so the tabs can step aside.
const view = window.visualViewport;
if (view) {
  const fit = () => {
    const root = document.documentElement;
    root.style.setProperty("--ph-height", `${view.height}px`);
    root.toggleAttribute("data-keyboard", window.innerHeight - view.height > 120);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  view.addEventListener("resize", fit);
  view.addEventListener("scroll", fit);
  fit();
}

createRoot(document.getElementById("root")!).render(<PhoneApp />);
