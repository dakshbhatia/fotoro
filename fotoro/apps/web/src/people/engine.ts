export class PeopleRuntimeUnavailable extends Error {
  constructor(message = "People models or runtime are unavailable. Try again.") {super(message);this.name="PeopleRuntimeUnavailable";}
}
export class PeopleEngine {
  private worker?: Worker;
  private serial = 0;
  private pending = new Map<number, {resolve: (value: unknown[]) => void; reject: (error: Error) => void; cleanup: () => void}>();
  async analyze(blob: Blob, signal: AbortSignal): Promise<unknown[]> {
    signal.throwIfAborted();
    if (!this.worker) {
      try {this.worker = new Worker(new URL("./people-worker.ts",import.meta.url), {type:"module"});}
      catch {throw new PeopleRuntimeUnavailable("People are unavailable in this browser.");}
      this.worker.onmessage = event => {
        const entry=this.pending.get(event.data.id); if (!entry) return;
        this.pending.delete(event.data.id); entry.cleanup();
        if(event.data.runtimeUnavailable) entry.reject(new PeopleRuntimeUnavailable());
        else if(event.data.error || !Array.isArray(event.data.faces) || event.data.faces.length>40) entry.reject(new Error("People are unavailable for this photo."));
        else entry.resolve(event.data.faces);
      };
      this.worker.onerror = () => this.clear(new PeopleRuntimeUnavailable("People are unavailable in this browser."));
    }
    return new Promise((resolve,reject)=> {
      const id=++this.serial;
      const abort=()=>this.clear(new DOMException("People cancelled","AbortError"));
      const timeout=setTimeout(()=>this.clear(new PeopleRuntimeUnavailable("People took too long. Try again.")),120000);
      const cleanup=()=> {clearTimeout(timeout);signal.removeEventListener("abort",abort);};
      signal.addEventListener("abort",abort,{once:true});
      this.pending.set(id,{resolve,reject,cleanup}); this.worker!.postMessage({id,blob});
    });
  }
  clear(error: Error = new DOMException("People cancelled","AbortError")) {
    this.worker?.terminate(); this.worker=undefined;
    for(const entry of this.pending.values()) {entry.cleanup();entry.reject(error);} this.pending.clear();
  }
}
