import { fail } from "./errors";

// JSON exchanges contain at most 100 manifests; encrypted media streams use
// their separate, reservation-bound byte limit.
export async function readJson<T = unknown>(request: Request, limit = 2 * 1024 * 1024): Promise<T> {
  if (Number(request.headers.get("content-length")) > limit) fail("TOO_LARGE", 413);
  if (!request.body) fail("INVALID_WIRE");
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        fail("TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("INVALID_WIRE");
  }
}
