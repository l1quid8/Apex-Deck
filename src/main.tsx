import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AppearancePreviewPage } from "./AppearancePreview";
import { isWindows } from "./paths";
import { PopoutApp } from "./PopoutApp";
import "./styles.css";
import "./glass-theme.css";
import "./clay-theme.css";
import "./appearance-settings.css";
import "./apex-agent-panel.css";
import "./popout.css";
import { AssistantFloat } from "./AssistantFloatWindow";
import "./bot-chip-styles.css";
import "./appearance-studio.css";

if (isWindows) document.documentElement.dataset.platform = "windows";

// A pop-out window shows one pane and never the deck: it mounts no layout,
// loads no startup state and saves nothing.
const query = new URLSearchParams(window.location.search);
const popoutToken = query.get("popout");
const floatToken = query.get("assistant-float");

// The Appearance preview is the same kind of window: real stylesheets, sample
// content, no backend.
createRoot(document.getElementById("root")!).render(query.has("appearance-preview") ? <AppearancePreviewPage /> : floatToken ? <AssistantFloat token={floatToken} /> : popoutToken ? <PopoutApp token={popoutToken} /> : <App />);
