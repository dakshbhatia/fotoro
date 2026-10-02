import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
test('asset preparation copies pinned worker, every feature-selected core with matching WASM, English and reproducible hashes',async()=>{
 const output=await mkdtemp(join(tmpdir(),'fotoro-ocr-assets-'));
 try {
  await promisify(execFile)(process.execPath,['tools/prepare-ocr-assets.mjs','--output',output]);
  const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.packages,{'tesseract.js':'7.0.0','tesseract.js-core':'7.0.0','@tesseract.js-data/eng':'1.0.0'});
  const expected=['worker.min.js','lang/eng.traineddata.gz',...['','-lstm','-simd','-simd-lstm','-relaxedsimd','-relaxedsimd-lstm'].flatMap(s=>['core/tesseract-core'+s+'.wasm.js','core/tesseract-core'+s+'.wasm'])];
  for(const path of expected){const bytes=await readFile(join(output,path));assert.ok(bytes.length>1000,path);assert.equal(manifest.files[path].sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(manifest.files[path].bytes,bytes.length);}
  const first=await readFile(join(output,'manifest.json'),'utf8');await promisify(execFile)(process.execPath,['tools/prepare-ocr-assets.mjs','--output',output]);assert.equal(await readFile(join(output,'manifest.json'),'utf8'),first);
 } finally {await rm(output,{recursive:true,force:true});}
});
