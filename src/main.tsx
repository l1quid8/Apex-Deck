import { createRoot } from "react-dom/client";

import { App } from "./App";
import { PopoutApp } from "./PopoutApp";
import "./styles.css";
import "./glass-theme.css";
import "./clay-theme.css";
import "./appearance-settings.css";
import "./apex-agent-panel.css";
import "./popout.css";
import { AssistantFloat } from "./AssistantFloatWindow";
import "./bot-chip-styles.css";

// A pop-out window shows one pane and never the deck: it mounts no layout,
// loads no startup state and saves nothing.
const query = new URLSearchParams(window.location.search);
const popoutToken = query.get("popout");
const floatToken = query.get("assistant-float");

createRoot(document.getElementById("root")!).render(floatToken ? <AssistantFloat token={floatToken} /> : popoutToken ? <PopoutApp token={popoutToken} /> : <App />);
