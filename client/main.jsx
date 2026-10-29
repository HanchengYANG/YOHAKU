import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import PWAManager from "./PWAManager.jsx";
import "./styles.css";
import "./stage2.css";
import "./accounts.css";
import "./books.css";
import "./import-progress.css";
import "./design-theme.css";
import "./welcome.css";
import "./pwa.css";

createRoot(document.getElementById("root")).render(
  <>
    <PWAManager />
    <App />
  </>,
);
