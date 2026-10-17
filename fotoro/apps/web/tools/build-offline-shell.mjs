import {readFile, readdir, stat, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {offlineWorker} from "./offline-shell.mjs";

const dist = new URL("../dist/", import.meta.url), assets = new URL("assets/", dist);
const paths = [];
for (const name of await readdir(assets)) {
  // Model/wasm downloads stay on-demand and obey their own existing consent and
  // retention controls. The shell cache is bounded to public JS/CSS resources.
  if (/\.(?:js|css)$/.test(name) && (await stat(new URL(name, assets))).size <= 2 * 1024 * 1024) paths.push("/assets/" + name);
}
const html = await readFile(new URL("index.html", dist), "utf8");
for (const [, path] of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)) {
  if (!paths.includes(path)) throw new Error("OFFLINE_ENTRY_NOT_CACHED");
}
await writeFile(fileURLToPath(new URL("offline-worker.js", dist)), offlineWorker(html, paths));
