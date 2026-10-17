import {diagnose} from "./diagnostics";

export function installOfflineShell() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const install = () => {
    void diagnose("metadata", async () => {
      await navigator.serviceWorker.register("/offline-worker.js", {scope: "/", updateViaCache: "none"});
    }).catch(() => {}); // Browsing still works if private mode or quota denies caching.
  };
  if (document.readyState === "complete") install();
  else window.addEventListener("load", install, {once: true});
}
