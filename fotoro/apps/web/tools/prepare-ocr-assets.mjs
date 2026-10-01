import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tesseractRoot = dirname(require.resolve('tesseract.js/package.json'));
const fromTesseract = createRequire(join(tesseractRoot, 'package.json'));
const coreRoot = dirname(fromTesseract.resolve('tesseract.js-core/package.json'));
const englishRoot = dirname(require.resolve('@tesseract.js-data/eng/package.json'));
const roots = {'tesseract.js':tesseractRoot, 'tesseract.js-core':coreRoot, '@tesseract.js-data/eng':englishRoot};
const packages = {};
for (const [name, root] of Object.entries(roots)) packages[name] = JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const pinned = {'tesseract.js':'7.0.0', 'tesseract.js-core':'7.0.0', '@tesseract.js-data/eng':'1.0.0'};
if (Object.entries(pinned).some(([name, version]) => packages[name] !== version)) throw new Error('Installed OCR packages differ from the pinned asset contract. Reinstall with the lockfile.');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : join(web,'public/ocr/v1');
const files = {};
async function copy(source, target) {
  const bytes = await readFile(source), path = join(output,target);
  await mkdir(dirname(path),{recursive:true});
  // Atomic replace preserves any running development worker's asset reads.
  const temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary,bytes); await rename(temporary,path);
  files[target] = {bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')};
}
await copy(join(tesseractRoot,'dist/worker.min.js'),'worker.min.js');
await copy(join(tesseractRoot,'dist/worker.min.js.LICENSE.txt'),'worker.LICENSE.txt');
await copy(join(tesseractRoot,'LICENSE.md'),'tesseract.LICENSE.txt');
await copy(join(coreRoot,'LICENSE'),'core/LICENSE.txt');
// 7.0.0 probes relaxed SIMD as well as the documented scalar/SIMD and LSTM variants.
for (const suffix of ['', '-lstm', '-simd', '-simd-lstm', '-relaxedsimd', '-relaxedsimd-lstm']) {
  for (const extension of ['.wasm.js', '.wasm']) {
    const name = 'tesseract-core' + suffix + extension;
    await copy(join(coreRoot,name),'core/' + name);
  }
}
await copy(join(englishRoot,'4.0.0_best_int/eng.traineddata.gz'),'lang/eng.traineddata.gz');
await copy(join(englishRoot,'package.json'),'lang/package.json');
const manifest = {version:1, packages, languageVariant:'4.0.0_best_int', provenance:'Installed npm packages, integrity-pinned by pnpm-lock.yaml; no build-time CDN download.', files};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Prepared pinned local OCR assets ('+Object.values(files).reduce((n,file)=>n+file.bytes,0)+' bytes).');
