import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
// @ts-expect-error Build-time JavaScript generator has no declaration file.
import {offlineWorker} from "../tools/offline-shell.mjs";

const origin = "https://fotoro.test";
const html = '<html><script src="/assets/app-123.js"></script></html>';
function harness({failInstall = false} = {}) {
  const events = new Map<string, (event: any) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const requests: Request[] = [];
  let offline = false, claims = 0;
  const key = (input: string | Request) => new URL(typeof input === "string" ? input : input.url, origin).href;
  const fetch = async (input: string | Request) => {
    const request = typeof input === "string" ? new Request(new URL(input, origin)) : input;
    requests.push(request);
    if (offline || failInstall && requests.length > 1) throw new TypeError("network unavailable");
    return new Response("network " + new URL(request.url).pathname);
  };
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async addAll(inputs: Request[]) {
          for (const input of inputs) store.set(key(input), await fetch(input));
        },
        async put(input: string | Request, value: Response) {store.set(key(input), value.clone());},
        async match(input: string | Request) {return store.get(key(input))?.clone();},
      };
    },
    async keys() {return [...stores.keys()];},
    async delete(name: string) {return stores.delete(name);},
  };
  class WorkerRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, origin) : input, init);
    }
  }
  const self = {location: {origin}, clients: {async claim() {claims++;}},
    addEventListener(name: string, callback: (event: any) => void) {events.set(name, callback);}};
  vm.runInNewContext(offlineWorker(html, ["/assets/app-123.js", "/assets/app.css", "/api/photos", "/private.jpg", "/assets/model.onnx"]),
    {self, caches, Request: WorkerRequest, Response, URL, fetch});
  return {stores, requests, get claims() {return claims;}, setOffline() {offline = true;},
    async lifecycle(type: string) {
      let work: Promise<unknown> | undefined;
      events.get(type)!({waitUntil(value: Promise<unknown>) {work = value;}});
      await work;
    },
    request(path: string, mode = "navigate", method = "GET") {
      let response: Promise<Response> | undefined;
      events.get("fetch")!({request: {url: new URL(path, origin).href, mode, method},
        respondWith(value: Promise<Response>) {response = value;}});
      return response;
    },
  };
}

test("installed shell supports cold offline navigation only on public app routes", async () => {
  const worker = harness();
  await worker.lifecycle("install");
  worker.setOffline();
  for (const path of ["/", "/saved", "/saved/"]) {
    const response = await worker.request(path);
    assert.equal(await response!.text(), html);
    assert.match(response!.headers.get("content-type")!, /text\/html/);
  }
  assert.equal(worker.stores.size, 1);
});

test("worker bypasses API, photos, query-bearing, cross-origin and non-GET requests", async () => {
  const worker = harness();
  await worker.lifecycle("install");
  const before = worker.requests.length;
  for (const path of ["/api/photos", "/photos/private.jpg", "/saved?token=private", "/assets/app-123.js?secret=private", "https://other.test/", "/unknown"]) {
    assert.equal(worker.request(path), undefined, path);
  }
  assert.equal(worker.request("/", "navigate", "POST"), undefined);
  assert.equal(worker.request("/assets/model.onnx", "cors"), undefined);
  assert.equal(worker.requests.length, before);
});

test("only allowlisted public JS/CSS is cached without credentials; online navigations are not stored", async () => {
  const worker = harness();
  await worker.lifecycle("install");
  assert.equal(worker.requests.length, 2);
  for (const request of worker.requests) {
    assert.equal(request.credentials, "omit");
    assert.equal(request.cache, "reload");
  }
  const response = await worker.request("/");
  assert.equal(await response!.text(), "network /");
  worker.setOffline();
  const asset = await worker.request("/assets/app-123.js", "cors");
  assert.equal(await asset!.text(), "network /assets/app-123.js");
  const entries = [...worker.stores.values()][0];
  assert.equal(entries.size, 3);
  assert.equal([...entries.keys()].some(key => new URL(key).pathname === "/"), false);
});

test("failed installation removes its incomplete shell cache", async () => {
  const worker = harness({failInstall: true});
  worker.stores.set("unrelated", new Map());
  await assert.rejects(worker.lifecycle("install"), /network unavailable/);
  assert.deepEqual([...worker.stores.keys()], ["unrelated"]);
});

test("installation waits for normal lifecycle; activation cleans only old Fotoro shell versions", async () => {
  const worker = harness();
  worker.stores.set("fotoro-shell-old", new Map());
  worker.stores.set("photo-private-storage", new Map());
  await worker.lifecycle("install");
  assert.equal(worker.claims, 0);
  assert.equal(worker.stores.has("fotoro-shell-old"), true);
  await worker.lifecycle("activate");
  assert.equal(worker.claims, 1);
  assert.equal(worker.stores.has("fotoro-shell-old"), false);
  assert.equal(worker.stores.has("photo-private-storage"), true);
  assert.equal(worker.stores.size, 2);
});


test("missing shell fails closed and a changed build gets a separate cache", async () => {
  const worker = harness();
  worker.setOffline();
  const response = await worker.request("/saved");
  assert.equal(response!.type, "error");
  const cacheName = (source: string) => /const CACHE = "([^"\n]+)"/.exec(source)![1];
  const first = cacheName(offlineWorker(html, ["/assets/a.js"]));
  assert.equal(first, cacheName(offlineWorker(html, ["/assets/a.js", "/assets/a.js", "/api/private"])));
  assert.notEqual(first, cacheName(offlineWorker(html + "<!-- new -->", ["/assets/a.js"])));
  assert.notEqual(first, cacheName(offlineWorker(html, ["/assets/b.js"])));
});
