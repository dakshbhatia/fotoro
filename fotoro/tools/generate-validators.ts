import Ajv from "ajv";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { writeFile } from "node:fs/promises";
import schema from "../packages/contracts/schema/contract-v1.schema.json";
const ajv = new Ajv({
  strict: true,
  allErrors: true,
  code: { source: true, esm: true },
});
addFormats(ajv);
ajv.addSchema(schema);
const exports = Object.fromEntries(
  Object.keys(schema.$defs).map((name) => [
    name,
    schema.$id + "#/$defs/" + name,
  ]),
);
const code =
  'import formatsModule from \"ajv-formats/dist/formats.js\";\nimport ucs2lengthModule from \"ajv/dist/runtime/ucs2length.js\";\nimport equalModule from \"ajv/dist/runtime/equal.js\";\nconst formats=formatsModule.fullFormats;const ucs2length=ucs2lengthModule.default ?? ucs2lengthModule;const equal=equalModule.default ?? equalModule;\n' +
  standaloneCode(ajv, exports);
await writeFile(
  "packages/contracts/src/validators.js",
  code
    .replace(/require\("ajv-formats\/dist\/formats"\)\.fullFormats/g, "formats")
    .replace(
      /require\("ajv\/dist\/runtime\/ucs2length"\)\.default/g,
      "ucs2length",
    )
    .replace(/require\("ajv\/dist\/runtime\/equal"\)\.default/g, "equal"),
);

await writeFile(
  "packages/contracts/src/validators.d.ts",
  Object.keys(schema.$defs)
    .map((name) => `export function ${name}(value:unknown):boolean;`)
    .join("\n") + "\n",
);
