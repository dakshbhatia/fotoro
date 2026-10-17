import { createRoot } from "react-dom/client";
import App from "./app";
import "./styles.css";
import "./local/photo-browse.css";
import {installOfflineShell} from "./offline-shell";
createRoot(document.getElementById("root")!).render(<App />);
installOfflineShell();
