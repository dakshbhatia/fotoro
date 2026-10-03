import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import ts from "typescript";

const web = fileURLToPath(new URL("../", import.meta.url));
const contracts = path.resolve(web, "../../packages/contracts");

function staticModules(source: string, filename: string) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, false,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : filename.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const modules: string[] = [];
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(binding => binding.isTypeOnly)) continue;
      modules.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every(binding => binding.isTypeOnly)) continue;
      modules.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)) {
      modules.push(node.moduleReference.expression.text);
    }
  }
  return modules;
}

function sourceModule(from: string, module: string): string | undefined {
  let base: string;
  if (module.startsWith(".")) base = path.resolve(path.dirname(from), module);
  else if (module === "@fotoro/contracts" || module.startsWith("@fotoro/contracts/")) {
    const exports = JSON.parse(readFileSync(path.join(contracts, "package.json"), "utf8")).exports as Record<string, string>;
    const key = module === "@fotoro/contracts" ? "." : "." + module.slice("@fotoro/contracts".length);
    assert.ok(exports[key], `Unknown contracts export: ${module}`);
    base = path.resolve(contracts, exports[key]);
  } else return undefined; // Third-party packages are bundled and measured below.
  const candidates = [base, base + ".ts", base + ".tsx", base + ".js",
    base.replace(/\.js$/, ".ts"), path.join(base, "index.ts"), path.join(base, "index.tsx")];
  const resolved = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  assert.ok(resolved, `Unresolved static module ${module} from ${path.relative(web, from)}`);
  return /\.(?:ts|tsx|js)$/.test(resolved) ? resolved : undefined;
}

test("startup parser follows runtime static imports and exports, separating type-only and dynamic edges", () => {
  const fixture = `
    import type {Vault} from "type-only";
    import {type Card} from "named-type-only";
    import {type Card, current} from "mixed";
    import Default, {type Card} from "default";
    import "side-effect";
    export type {Vault} from "export-type-only";
    export {type Card} from "named-export-type-only";
    export {type Card, current} from "export-mixed";
    export * from "export-all";
    const account = () => import("deferred-account");
    type Crypto = typeof import("deferred-type");
  `;
  assert.deepEqual(staticModules(fixture, "fixture.ts"),
    ["mixed", "default", "side-effect", "export-mixed", "export-all"]);
});

test("local Photos startup has no static account crypto dependency", () => {
  const pending = [path.join(web, "src/main.tsx")], visited = new Set<string>();
  while (pending.length) {
    const filename = pending.pop()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    const relative = path.relative(web, filename).replaceAll(path.sep, "/");
    assert.ok(!["src/CloudApp.tsx", "src/vault/crypto-runtime.ts"].includes(relative),
      `Account-only module entered local startup: ${relative}`);
    for (const module of staticModules(readFileSync(filename, "utf8"), filename)) {
      assert.ok(!(module === "@fotoro/crypto" || module.startsWith("@fotoro/crypto/") || /^libsodium(?:-|$)/.test(module)),
        `Account crypto entered local startup through ${relative}: ${module}`);
      const dependency = sourceModule(filename, module);
      if (dependency) pending.push(dependency);
    }
  }
  assert.ok(visited.has(path.join(web, "src/local/LocalTrial.tsx")), "The local Photos surface must be checked");
  assert.ok(visited.has(path.join(web, "src/vault/vault.ts")), "Lightweight vault state must be checked");
});

test("built static startup graph stays within 500 KiB", context => {
  const dist = path.join(web, "dist"), index = path.join(dist, "index.html");
  if (!existsSync(index)) {context.skip("Run pnpm build:web to verify the emitted startup byte budget."); return;}
  const html = readFileSync(index, "utf8"), pending: string[] = [];
  function asset(value: string, parent = "https://fotoro.invalid/") {
    const url = new URL(value, parent);
    assert.equal(url.origin, "https://fotoro.invalid", "Startup assets must be measurable same-origin files");
    return decodeURIComponent(url.pathname).replace(/^\//, "");
  }
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    if (/^<script/i.test(tag[0]) && /\btype=["']module["']/i.test(tag[0])) {
      const src = /\bsrc=["']([^"']+)["']/i.exec(tag[0])?.[1];
      if (src) pending.push(asset(src));
    } else if (/^<link/i.test(tag[0]) && /\brel=["']modulepreload["']/i.test(tag[0])) {
      const href = /\bhref=["']([^"']+)["']/i.exec(tag[0])?.[1];
      if (href) pending.push(asset(href));
    }
  }
  assert.ok(pending.length, "A built module startup entry must exist");
  const visited = new Set<string>();
  let bytes = 0;
  while (pending.length) {
    const filename = pending.pop()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    const contents = readFileSync(path.join(dist, filename));
    bytes += contents.byteLength;
    for (const module of staticModules(contents.toString("utf8"), filename)) {
      assert.ok(module.startsWith(".") || module.startsWith("/"), `Unmeasured external startup import: ${module}`);
      pending.push(asset(module, "https://fotoro.invalid/" + filename));
    }
  }
  assert.ok(bytes <= 500 * 1024,
    `Startup JavaScript is ${bytes} bytes across ${visited.size} static chunks; budget is 500 KiB. Account crypto must remain deferred.`);
  context.diagnostic(`Static startup JavaScript: ${bytes} bytes across ${visited.size} chunks.`);
});
