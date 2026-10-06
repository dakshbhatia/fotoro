import {SEMANTIC_ASSETS, semanticAssetCache, semanticAssetFetch, semanticWasmRuntime} from "../local/semantic-config";
export const PEOPLE_MODEL_COMMIT = "47534e27c9851bb1128ccc0102f1145e27f23f98";
const root = `https://media.githubusercontent.com/media/opencv/opencv_zoo/${PEOPLE_MODEL_COMMIT}/models/`;
export const YUNET_URL = root + "face_detection_yunet/face_detection_yunet_2023mar.onnx";
export const SFACE_URL = root + "face_recognition_sface/face_recognition_sface_2021dec.onnx";
export const PEOPLE_ASSETS: ReadonlyMap<string, readonly [number, string]> = new Map([
  [YUNET_URL, [232589, "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"]],
  [SFACE_URL, [38696353, "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"]],
  ...[...SEMANTIC_ASSETS].filter(([url]) => url.startsWith("https://cdn.jsdelivr.net/npm/onnxruntime-web@")),
]);
export async function preparePeopleModels() {
  const fetch = semanticAssetFetch(undefined, PEOPLE_ASSETS), cache = semanticAssetCache(async () => {
    try {return typeof caches === "undefined" ? undefined : await caches.open(`fotoro-people-models-${PEOPLE_MODEL_COMMIT}`);} catch {return;}
  }, PEOPLE_ASSETS);
  const load = async (url: string) => {
    const cached = await cache.match(url); if (cached) return cached.arrayBuffer();
    const response = await fetch(url); if (!response.ok) throw new Error("People models are unavailable.");
    await cache.put(url, response.clone()).catch(() => {}); return response.arrayBuffer();
  };
  const safari = /Safari/.test(navigator.userAgent) && !/(?:Chrome|Chromium|CriOS|Android)/.test(navigator.userAgent);
  const [detector, recognizer, runtime] = await Promise.all([load(YUNET_URL), load(SFACE_URL), semanticWasmRuntime(fetch, cache, safari)]);
  return {detector, recognizer, runtime};
}
