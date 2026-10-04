export const SEMANTIC_MODEL = "Xenova/mobileclip_s0";
export const SEMANTIC_REVISION = "20c6e4f26ad3f7f7e9cde13c4f9bb54852dd42c6";
export const SEMANTIC_DIMENSIONS = 512;
export const SEMANTIC_THRESHOLD = .20;
export const SEMANTIC_RUNTIME = "1.25.0-dev.20260327-722743c0e2";
const modelRoot = `https://huggingface.co/${SEMANTIC_MODEL}/resolve/${SEMANTIC_REVISION}/`;
const wasmRoot = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${SEMANTIC_RUNTIME}/dist/`;
// SHA-256 and sizes come from this immutable Hub revision and the installed runtime package.
const modelAssets = {
  "config.json": [240, "9653c701b559b191c969929f640615ea386afb9d16deb08ba1520078bf4be23a"],
  "preprocessor_config.json": [382, "b031f09fbd69e22a605b6cc7433993249ee893b7fc1b79321f669cd015493dd4"],
  "tokenizer_config.json": [763, "a7d9d24f248071b792e4a3b56ab0539c2f40eec8da56d6fd91fb3a50058acebd"],
  "tokenizer.json": [2224081, "72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85"],
  "onnx/text_model_quantized.onnx": [42799238, "b8557b10e5c23a0126c6d2e6eba48d240484979007917d128953b31618a04211"],
  "onnx/vision_model.onnx": [45543630, "17d3c037b1d488c10c50e09f6009ea5a198caef4e0e8f4ea5617b7cb2d067ac0"],
} as const;
const wasmAssets = {
  "ort-wasm-simd-threaded.asyncify.mjs": [47396, "c7646f325a5e0e69861cde52218993a15b10046fec85bb6a8c4917474fe9af79"],
  "ort-wasm-simd-threaded.asyncify.wasm": [22819905, "109c563dbbfebcebae5006d9978f85abb1d8292622e561bdc41b7a019f8b0096"],
  "ort-wasm-simd-threaded.mjs": [24274, "1fb7c33cf1ace9b6905d0ebeb01d25cd46f7d5c7cb1ecdd58cc735bd8ff87be0"],
  "ort-wasm-simd-threaded.wasm": [12528402, "07a97c7185bece61ed42fd6864aa488ec60b54416334197970f18a72f5455b5d"],
} as const;
export const SEMANTIC_ASSETS: ReadonlyMap<string, readonly [number, string]> = new Map<string, readonly [number, string]>([
  ...Object.entries(modelAssets).map(([path, asset]) => [modelRoot + path, asset] as const),
  ...Object.entries(wasmAssets).map(([path, asset]) => [wasmRoot + path, asset] as const),
]);

export async function verifySemanticAsset(url: string, response: Response, assets = SEMANTIC_ASSETS): Promise<Response> {
  const expected = assets.get(url);
  if (!expected || response.status !== 200 || !response.body) throw new Error("Visual search asset unavailable.");
  const reader = response.body.getReader(), bytes = new Uint8Array(expected[0]);
  let at = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (at + chunk.value.byteLength > bytes.length) throw new Error("Visual search asset is invalid.");
      bytes.set(chunk.value, at); at += chunk.value.byteLength;
    }
    if (at !== bytes.length) throw new Error("Visual search asset is invalid.");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    if (hash !== expected[1]) throw new Error("Visual search asset is invalid.");
    return new Response(bytes, {headers: response.headers});
  } catch (error) {await reader.cancel().catch(() => {}); throw error;}
  finally {reader.releaseLock();}
}

export function semanticAssetFetch(fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis), assets = SEMANTIC_ASSETS) {
  return async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (init.body != null || (init.method && init.method.toUpperCase() !== "GET")) throw new Error("Visual search only loads public assets.");
    if (!assets.has(url)) {
      // Transformers probes optional processor/tokenizer files. Unlisted files are never requested.
      if (url.startsWith(modelRoot) && !new URL(url).search) return new Response(null, {status: 404});
      throw new Error("Visual search asset unavailable.");
    }
    const headers = new Headers(init.headers); headers.delete("Authorization");
    // Transformers 4 tokenizer discovery probes one byte for metadata. Answer from the pinned
    // size manifest; only full, hash-verified responses can enter tokenizers/models/runtime.
    if (headers.get("Range") === "bytes=0-0") return new Response(null, {status: 206, headers: {"Content-Range": `bytes 0-0/${assets.get(url)![0]}`}});
    headers.delete("Range");
    const timeout = AbortSignal.timeout(60000), signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(url, {...init, headers, signal, credentials: "omit", referrerPolicy: "no-referrer"});
    if (!response.ok) return response;
    return verifySemanticAsset(url, response, assets);
  };
}

type AssetCache = Pick<Cache, "match" | "put" | "delete">;
export function semanticAssetCache(open: () => Promise<AssetCache | undefined> = async () => {
  try {return typeof caches === "undefined" ? undefined : await caches.open(`fotoro-semantic-${SEMANTIC_REVISION}-${SEMANTIC_RUNTIME}`);} catch {return;}
}, assets = SEMANTIC_ASSETS) {
  let cache: Promise<AssetCache | undefined> | undefined;
  const read = () => cache ??= open();
  return {
    async match(url: string) {
      if (!assets.has(url)) return;
      const store = await read(), response = await store?.match(url);
      if (!response) return;
      try {return await verifySemanticAsset(url, response, assets);} catch {await store?.delete(url); return;}
    },
    async put(url: string, response: Response) {
      if (!assets.has(url)) throw new Error("Visual search asset unavailable.");
      const verified = await verifySemanticAsset(url, response, assets);
      await (await read())?.put(url, verified);
    },
  };
}

export function retryableSemanticModels<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      const attempt = Promise.resolve().then(load).catch(error => {if (pending === attempt) pending = undefined; throw error;});
      pending = attempt;
    }
    return pending;
  };
}
export function zeroSemanticPadding(inputs: {input_ids: {data: ArrayLike<number | bigint>}; attention_mask: {data: ArrayLike<number | bigint>}}) {
  if (inputs.input_ids.data.length !== inputs.attention_mask.data.length) throw new Error("Visual search text is invalid.");
  for (let i = 0; i < inputs.input_ids.data.length; i++) if (Number(inputs.attention_mask.data[i]) === 0)
    (inputs.input_ids.data as {[index: number]: number | bigint})[i] = typeof inputs.input_ids.data[i] === "bigint" ? 0n : 0;
}

export async function semanticWasmRuntime(fetch: ReturnType<typeof semanticAssetFetch>, cache: ReturnType<typeof semanticAssetCache>, safari: boolean) {
  const basename = safari ? "ort-wasm-simd-threaded" : "ort-wasm-simd-threaded.asyncify";
  const load = async (url: string) => {
    const cached = await cache.match(url);
    if (cached) return cached;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Visual search runtime unavailable.");
    await cache.put(url, response.clone()).catch(() => {});
    return response;
  };
  const [wasm, factory] = await Promise.all([load(wasmRoot + basename + ".wasm"), load(wasmRoot + basename + ".mjs")]);
  return {wasmBinary: await wasm.arrayBuffer(), wasmPaths: {wasm: wasmRoot + basename + ".wasm",
    mjs: URL.createObjectURL(new Blob([await factory.text()], {type: "text/javascript"}))}};
}
