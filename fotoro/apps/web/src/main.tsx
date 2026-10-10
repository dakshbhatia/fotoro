import { createRoot } from "react-dom/client";
import App from "./app";
import "./styles.css";
import "./local/photo-browse.css";
createRoot(document.getElementById("root")!).render(<App />);
