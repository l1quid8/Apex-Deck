import { createRoot } from "react-dom/client";

import "../styles.css";
import "./phone.css";
import { PhoneApp } from "./PhoneApp";

createRoot(document.getElementById("root")!).render(<PhoneApp />);
