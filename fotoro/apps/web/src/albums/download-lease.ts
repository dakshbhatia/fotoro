import type {TripDownload} from "./download";
interface DownloadEnvironment {
  createURL: (file: File) => string;
  revokeURL: (url: string) => void;
  download: (url: string, filename: string) => void;
}
const browser: DownloadEnvironment = {
  createURL: file => URL.createObjectURL(file), revokeURL: url => URL.revokeObjectURL(url),
  download(url, filename) {
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.append(anchor);
    try {anchor.click();} finally {anchor.remove();}
  },
};
// An OPFS-backed File remains readable only while its backing entry survives.
// Downloads have no browser completion event, so the trip explicitly owns it.
export class TripDownloadLease {
  private url?: string;
  private result?: TripDownload;
  private started = false;
  private releasing?: Promise<void>;
  constructor(result: TripDownload, private environment: DownloadEnvironment = browser) {this.result = result;}
  get published() {return this.started;}
  publish(current: () => boolean) {
    if (!this.result || this.started || !current()) throw new DOMException("Trip download cancelled", "AbortError");
    this.url = this.environment.createURL(this.result.file);
    if (!current()) {this.environment.revokeURL(this.url); this.url = undefined; throw new DOMException("Trip download cancelled", "AbortError");}
    this.environment.download(this.url, this.result.file.name); this.started = true;
  }
  dispose() {
    if (this.releasing) return this.releasing;
    const result = this.result; this.result = undefined; this.started = false;
    if (this.url) {this.environment.revokeURL(this.url); this.url = undefined;}
    return this.releasing = result?.dispose() ?? Promise.resolve();
  }
}
