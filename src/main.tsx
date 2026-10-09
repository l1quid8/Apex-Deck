import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "./glass-theme.css";
import "./appearance-settings.css";
import "./apex-agent-panel.css";
import "./apex-agent-widget.css";

createRoot(document.getElementById("root")!).render(<App />);
