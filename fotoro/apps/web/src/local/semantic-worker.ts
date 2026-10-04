import {AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage, env} from "@huggingface/transformers";
import {SEMANTIC_MODEL, SEMANTIC_REVISION, semanticAssetFetch, semanticAssetCache, semanticWasmRuntime, retryableSemanticModels, zeroSemanticPadding} from "./semantic-config";
env.allowLocalModels = false;
// Transformers 4 tokenizer discovery omits its caller's revision. Fence every Hub path here.
env.remotePathTemplate = `{model}/resolve/${SEMANTIC_REVISION}/`;
const fetchAssets = semanticAssetFetch(), cachedAssets = semanticAssetCache();
env.fetch = fetchAssets;
env.useBrowserCache = false; env.useFSCache = false;
env.useCustomCache = true; env.customCache = cachedAssets;
// Preload verified bytes ourselves; ONNX must not fall back to an unverified native fetch/import.
env.useWasmCache = false;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;
const prepareRuntime = retryableSemanticModels(async () => {
  const safari = /Safari/.test(navigator.userAgent) && !/(?:Chrome|Chromium|CriOS|Android)/.test(navigator.userAgent);
  const runtime = await semanticWasmRuntime(fetchAssets, cachedAssets, safari);
  if (!env.backends.onnx.wasm) throw new Error("Visual search runtime unavailable.");
  Object.assign(env.backends.onnx.wasm, runtime);
});
const prepare = retryableSemanticModels(async () => {
    await prepareRuntime();
    const options = {revision: SEMANTIC_REVISION, device: "wasm" as const};
    const parts = await Promise.allSettled([
      AutoTokenizer.from_pretrained(SEMANTIC_MODEL, options), AutoProcessor.from_pretrained(SEMANTIC_MODEL, options),
      CLIPTextModelWithProjection.from_pretrained(SEMANTIC_MODEL, {...options, dtype: "q8"}),
      CLIPVisionModelWithProjection.from_pretrained(SEMANTIC_MODEL, {...options, dtype: "fp32"})] as const);
    if (parts.some(part => part.status === "rejected")) {
      await Promise.allSettled(parts.map(part => part.status === "fulfilled" && "dispose" in part.value ? part.value.dispose() : Promise.resolve()));
      throw new Error("Visual search is unavailable.");
    }
    const value = <T>(part: PromiseSettledResult<T>) => {if (part.status !== "fulfilled") throw new Error("Visual search is unavailable."); return part.value;};
    return {tokenizer: value(parts[0]), processor: value(parts[1]), text: value(parts[2]), image: value(parts[3])};
});
let queue = Promise.resolve();
let cancelledThrough = 0;
self.onmessage = event => {
  const message = event.data;
  if (message.kind === "cancel") {cancelledThrough = Math.max(cancelledThrough, message.through); return;}
  queue = queue.then(async () => {
    try {
      if (message.id <= cancelledThrough) return;
      const model = await prepare();
      if (message.id <= cancelledThrough) return;
      let values: ArrayLike<number>;
      if (message.kind === "text") {
        if (typeof message.text !== "string") throw new Error("Invalid query");
        const inputs = model.tokenizer(message.text.slice(0, 2048), {padding: "max_length", max_length: 77, truncation: true});
        zeroSemanticPadding(inputs);
        const output = await model.text(inputs); values = output.text_embeds.data;
      } else {
        const image = await RawImage.fromBlob(message.blob);
        const inputs = await model.processor(image);
        const output = await model.image(inputs); values = output.image_embeds.data;
      }
      const vector = Float32Array.from(values);
      if (message.id <= cancelledThrough) return;
      self.postMessage({id: message.id, vector}, {transfer: [vector.buffer]});
    } catch (error) {
      if (import.meta.env.DEV) console.warn("Visual search unavailable:", error instanceof Error ? error.message : "worker failure");
      self.postMessage({id: message.id, error: true});
    }
  });
};
