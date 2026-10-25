import { createRoot } from "react-dom/client";

import { App } from "./App";
import { isWindows } from "./paths";
import { PopoutApp } from "./PopoutApp";
import "./styles.css";
import "./glass-theme.css";
import "./clay-theme.css";
import "./appearance-settings.css";
import "./apex-agent-panel.css";
import "./popout.css";
import "./bot-chip-styles.css";

if (isWindows) document.documentElement.dataset.platform = "windows";

// A pop-out window shows one pane and never the deck: it mounts no layout,
// loads no startup state and saves nothing.
const popoutToken = new URLSearchParams(window.location.search).get("popout");

createRoot(document.getElementById("root")!).render(popoutToken ? <PopoutApp token={popoutToken} /> : <App />);
