import { imageDimensions } from './resources';
/* Optional OCR. Every runtime asset is served by this origin. */
export const OCR_PROCESSOR = 'tesseract.js-7.0.0/eng-1.0.0/lstm-orientation-v2';
export const OCR_ASSET_PATH = '/ocr/v1';
// Engineering gate for OCR coverage, not a calibrated probability of intent or accuracy.
export const OCR_MIN_CONFIDENCE = 0.60;
export interface OcrPreview { blob: Blob; width: number; height: number }
export interface OcrResult {
  photoID: string; revision: string; processor: string;
  status: 'complete' | 'failed'; text: string; confidence: number; error?: string;
}
export interface OcrProgress { photoID: string; status: string; progress: number }
interface WorkerProgress { status: string; progress: number }
export interface OcrWorker {
  recognize(image: Blob, options: { rotateAuto: boolean; rotateRadians?: number }): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}
export function localOcrOptions(origin: string, logger: (message: WorkerProgress) => void = () => {}, errorHandler: (error: unknown) => void = () => {}) {
  const url = new URL(origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin)
    throw new Error('OCR requires the current HTTP(S) origin.');
  const path = (suffix: string) => new URL(OCR_ASSET_PATH + suffix, origin).href;
  return {
    workerPath: path('/worker.min.js'), corePath: path('/core'), langPath: path('/lang'),
    workerBlobURL: false, cacheMethod: 'none', gzip: true, logger, errorHandler,
  };
}
export type OcrWorkerFactory = (options: ReturnType<typeof localOcrOptions>, signal: AbortSignal) => Promise<OcrWorker>;
/*
 * Minimal host for the pinned 7.0.0 worker protocol (src/createWorker.js).
 * Owning Worker before initialization lets cancellation terminate it immediately;
 * upstream's public createWorker only exposes its handle after initialization.
 */
export async function createLocalOcrWorker(
  options: ReturnType<typeof localOcrOptions>,
  signal: AbortSignal,
  spawn: (path: string) => Worker = path => new Worker(path),
): Promise<OcrWorker> {
  const origin = new URL(options.workerPath).origin;
  if ([options.workerPath, options.corePath, options.langPath].some(path => new URL(path).origin !== origin)
      || (globalThis.location && origin !== globalThis.location.origin))
    throw new Error('OCR assets must use the current origin.');
  if (signal.aborted) throw aborted();
  const native = spawn(options.workerPath), workerID = crypto.randomUUID();
  let sequence = 0, stopped = false;
  const pending = new Map<string, { action: string; resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const stop = (error: Error = aborted()) => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener('abort', cancel);
    native.terminate();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const cancel = () => stop();
  signal.addEventListener('abort', cancel, { once: true });
  native.onmessage = event => {
    const message = event.data, request = pending.get(message?.jobId);
    if (stopped || !request || message.workerId !== workerID || message.action !== request.action) return;
    if (message.status === 'progress') {
      options.logger(message.data);
    } else if (message.status === 'resolve' || message.status === 'reject') {
      clearTimeout(request.timer);
      pending.delete(message.jobId);
      if (message.status === 'resolve') request.resolve(message.data);
      else request.reject(new Error(String(message.data)));
    }
  };
  native.onerror = event => stop(new Error(event.message || 'The local OCR worker failed.'));
  native.onmessageerror = () => stop(new Error('The local OCR worker returned unreadable data.'));
  const job = (action: string, payload: unknown): Promise<any> => {
    if (stopped) return Promise.reject(aborted());
    const jobId = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(new Error('Local text recognition timed out.')), 60_000);
      pending.set(jobId, {action, resolve, reject, timer});
      try { native.postMessage({workerId: workerID, jobId, action, payload}); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
  };
  try {
    await job('load', {options: {lstmOnly: true, corePath: options.corePath, logging: false}});
    await job('loadLanguage', {langs: 'eng', options: {langPath: options.langPath, gzip: true, cacheMethod: 'none', lstmOnly: true}});
    await job('initialize', {langs: 'eng', oem: 1, config: {}});
  } catch (error) {
    stop(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  return {
    async recognize(blob, recognizeOptions) {
      const image = new Uint8Array(await blob.arrayBuffer());
      const data = await job('recognize', {image, options: recognizeOptions, output: {text: true}});
      return {data};
    },
    async terminate() { stop(); },
  };
}
const createLocalWorker: OcrWorkerFactory = (options, signal) => createLocalOcrWorker(options, signal);
const aborted = () => new DOMException('OCR was cancelled.', 'AbortError');
function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(aborted());
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
/* One serial reusable worker. Cancel fences preview, initialization and recognition completions. */
export class LocalOcrQueue {
  private generation = 0;
  private controller = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private worker?: { generation: number; promise: Promise<OcrWorker> };
  private retiring: Promise<unknown> = Promise.resolve();
  private report?: (message: WorkerProgress) => void;
  private factory: OcrWorkerFactory;
  private origin: string;
  private onProgress?: (progress: OcrProgress) => void;
  constructor(options: { origin?: string; createWorker?: OcrWorkerFactory; onProgress?: (progress: OcrProgress) => void } = {}) {
    this.origin = options.origin ?? globalThis.location.origin;
    localOcrOptions(this.origin);
    if (globalThis.location && this.origin !== globalThis.location.origin)
      throw new Error('OCR requires the current origin.');
    this.factory = options.createWorker ?? createLocalWorker;
    this.onProgress = options.onProgress;
  }
  recognize(photoID: string, revision: string, preview: () => Promise<OcrPreview>, isCurrent: () => boolean = () => true): Promise<OcrResult | undefined> {
    const generation = this.generation, signal = this.controller.signal;
    const current = () => generation === this.generation && !signal.aborted && isCurrent();
    const operation = this.tail.then(async () => {
      if (!current()) return;
      const progress = (status: string, value = 0) => {
        if (current()) this.onProgress?.({photoID, status, progress: value});
      };
      this.report = message => progress(message.status, Math.max(0, Math.min(1, message.progress)));
      try {
        progress('Preparing text preview');
        if (!current()) return;
        const image = await untilCancelled(preview(), signal);
        if (!current()) return;
        if (!image.blob.size || !['image/jpeg', 'image/png'].includes(image.blob.type))
          throw new Error('A readable JPEG or PNG preview is required for OCR.');
        if (![image.width, image.height].every(n => Number.isInteger(n) && n > 0 && n <= 1600))
          throw new Error('OCR preview dimensions must be bounded to 1600 pixels.');
        const dimensions = imageDimensions(new Uint8Array(await untilCancelled(image.blob.slice(0, 256 * 1024).arrayBuffer(), signal)));
        if (!current()) return;
        if (!dimensions || dimensions.width !== image.width || dimensions.height !== image.height
            || dimensions.width > 1600 || dimensions.height > 1600)
          throw new Error('OCR requires a readable bounded preview, with matching dimensions.');
        progress('Starting local text recognition');
        if (!current()) return;
        if (!this.worker) {
          const options = localOcrOptions(this.origin, message => {
            if (generation === this.generation) this.report?.(message);
          });
          this.worker = { generation, promise: this.retiring.then(() => {
            if (!current()) throw aborted();
            return this.factory(options, signal);
          }) };
        }
        const worker = await untilCancelled(this.worker.promise, signal);
        if (!current()) return;
        const read = async (options: {rotateAuto: boolean; rotateRadians?: number}) => {
          const result = await untilCancelled(worker.recognize(image.blob, options), signal);
          if (!current()) return;
          if (typeof result.data.text !== 'string' || !Number.isFinite(result.data.confidence))
            throw new Error('Local text recognition returned unreadable output.');
          return {text: result.data.text, confidence: Math.max(0, Math.min(1, result.data.confidence / 100))};
        };
        let best = await read({rotateAuto: true});
        if (!best || !current()) return;
        // A blank preview is a complete empty observation, not a fabricated match.
        // Only nonempty low-quality output gets bounded orientation fallback.
        if (best.text.trim() && best.confidence < OCR_MIN_CONFIDENCE) {
          for (const angle of [Math.PI / 2, Math.PI, Math.PI * 1.5]) {
            if (!current()) return;
            progress('Checking text orientation');
            if (!current()) return;
            // Tesseract ignores rotateRadians when rotateAuto is true.
            const candidate = await read({rotateAuto: false, rotateRadians: angle});
            if (!candidate || !current()) return;
            if (candidate.text.trim() && candidate.confidence > best.confidence) best = candidate;
          }
          if (best.confidence < OCR_MIN_CONFIDENCE)
            throw new Error('Text could not be read reliably from this preview.');
        }
        progress('Text recognition complete', 1);
        if (!current()) return;
        return {photoID, revision, processor: OCR_PROCESSOR, status: 'complete' as const,
          text: best.text, confidence: best.confidence};
      } catch (error) {
        if (!current()) return;
        const failed = this.worker;
        this.worker = undefined;
        if (failed) {
          this.retiring = failed.promise.then(worker => worker.terminate()).catch(() => {});
          await this.retiring;
        }
        if (!current()) return;
        progress('Text recognition unavailable');
        if (!current()) return;
        return { photoID, revision, processor: OCR_PROCESSOR, status: 'failed' as const, text: '', confidence: 0,
          error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (generation === this.generation) this.report = undefined;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  /* Clear, toggle-off and unmount use this fence; initialization is retired when it resolves. */
  cancel(): Promise<void> {
    this.generation++;
    this.report = undefined;
    this.controller.abort();
    this.controller = new AbortController();
    const old = this.worker;
    this.worker = undefined;
    if (old) this.retiring = old.promise.then(worker => worker.terminate()).catch(() => {});
    return this.retiring.then(() => {});
  }
}
