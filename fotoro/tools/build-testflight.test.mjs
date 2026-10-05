import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {SourceTextModule,SyntheticModule} from 'node:vm';
import test from 'node:test';

// Exercise the real release script; only external Xcode/Apple tools are doubled.
const source = fileURLToPath(new URL('./build-testflight.mjs',import.meta.url));
const UUID='11111111-2222-3333-4444-555555555555';
const crypto=['_sodium_init','_crypto_pwhash','_crypto_sign_detached','_crypto_sign_verify_detached',
 '_crypto_aead_xchacha20poly1305_ietf_encrypt','_crypto_aead_xchacha20poly1305_ietf_decrypt',
 '_crypto_secretstream_xchacha20poly1305_init_pull','_crypto_secretstream_xchacha20poly1305_init_push',
 '_crypto_secretstream_xchacha20poly1305_pull','_crypto_secretstream_xchacha20poly1305_push'];
function macho(path){fs.mkdirSync(join(path,'..'),{recursive:true});fs.writeFileSync(path,Buffer.from([0xcf,0xfa,0xed,0xfe,0,0,0,0]));}
async function release({mode='encrypted',missingDsym=false,ipaBuild='36',encryptedDeclaration,appIdentifier="TESTTEAM00.cloud.fotoro.Fotoro",extraExecutable=false,cryptoDefined=true,upload=true}={}){
 const roots=[],calls=[],cache=new Map();let archive,app;
 const originalArgv=process.argv,originalEnv=process.env;
 process.argv=['node',source,'36',...(upload?['--upload']:[])];
 process.env={...process.env,FOTORO_DEVELOPMENT_TEAM:'TESTTEAM00'};
 for(const k of ['ASC_KEY_PATH','ASC_KEY_ID','ASC_ISSUER_ID','ASC_KEY_SUBJECT'])delete process.env[k];
 const result=(stdout='',status=0)=>({stdout,stderr:status?'PRIVATE-DIAGNOSTIC':'',status});
 const entitlements={'application-identifier':appIdentifier,
  'com.apple.developer.associated-domains':['webcredentials:fotoro.cloud','applinks:fotoro.cloud'],
  'get-task-allow':false};
 const tool=(command,args,options={})=>{
  if(command.endsWith('/plutil'))return result(args.at(-1)==='-'?options.input:fs.readFileSync(args.at(-1),'utf8'));
  if(command.endsWith('/codesign'))return result(args.includes('--verify')?'':JSON.stringify(entitlements));
  if(command.endsWith('/dwarfdump'))return result(`UUID: ${UUID} (arm64) PRIVATE-PATH\n`);
  if(command.endsWith('/nm'))return result(crypto.map(symbol=>`${cryptoDefined?'0000000100000000 T':'                 U'} ${symbol}`).join('\n'));
  if(command.endsWith('/strings'))return result('AppServices CryptoAdapter https://fotoro.cloud');
  if(command.endsWith('/unzip')){
   if(args.includes('-Z1'))return result('Payload/\nPayload/Fotoro.app/\nPayload/Fotoro.app/Fotoro\n');
   const dir=args[args.indexOf('-d')+1];fs.mkdirSync(join(dir,'Payload'),{recursive:true});fs.cpSync(app,join(dir,'Payload/Fotoro.app'),{recursive:true});
   const p=join(dir,'Payload/Fotoro.app/Info.plist');const info=JSON.parse(fs.readFileSync(p));info.CFBundleVersion=ipaBuild;fs.writeFileSync(p,JSON.stringify(info));return result();
  }
  if(command.endsWith('/zipinfo'))return result('-rw-r--r-- 3.0 unx 1 bx 1 stor 26-Oct-01 00:00 entry\n'.repeat(3));
  throw Error('Unexpected tool');
 };
 const spawn=(_command,args)=>{
  calls.push(args);const child=new EventEmitter();queueMicrotask(()=>{
   if(args.includes('archive')){
    archive=args[args.indexOf('-archivePath')+1];app=join(archive,'Products/Applications/Fotoro.app');fs.mkdirSync(app,{recursive:true});
    const info={CFBundleIdentifier:'cloud.fotoro.Fotoro',CFBundleExecutable:'Fotoro',CFBundleVersion:'36',CFBundleShortVersionString:'1.0',FotoroBuildMode:mode};
    if(encryptedDeclaration!==undefined)info.ITSAppUsesNonExemptEncryption=encryptedDeclaration;
    fs.writeFileSync(join(app,'Info.plist'),JSON.stringify(info));macho(join(app,'Fotoro'));
    if(extraExecutable)macho(join(app,'Resources/hidden.dat'));
    if(!missingDsym)macho(join(archive,'dSYMs/Fotoro.app.dSYM/Contents/Resources/DWARF/Fotoro'));
   }else{
    const target=args[args.indexOf('-exportPath')+1];fs.mkdirSync(target,{recursive:true});fs.writeFileSync(join(target,'Fotoro.ipa'),'fixture');
   }
   child.emit('close',0);
  });return child;
 };
 async function load(path){
  if(cache.has(path))return cache.get(path);
  const module=new SourceTextModule(fs.readFileSync(path,'utf8'),{identifier:pathToFileURL(path).href,initializeImportMeta(meta){meta.url=pathToFileURL(path).href;}});cache.set(path,module);
  await module.link(async spec=>{
   if(spec.startsWith('.'))return load(fileURLToPath(new URL(spec,pathToFileURL(path))));
   const values=spec==='node:child_process'?{spawn,spawnSync:tool,execFileSync:()=>''}:spec==='node:fs'?{...fs,mkdtempSync:(prefix)=>{const p=fs.mkdtempSync(prefix);roots.push(p);return p;}}:await import(spec);
   return new SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);});
  });return module;
 }
 let error;
 try{await(await load(source)).evaluate();}catch(e){error=e;}
 finally{process.argv=originalArgv;process.env=originalEnv;for(const p of roots)fs.rmSync(p,{recursive:true,force:true});}
 return {error,calls};
}
test('full release rejects preview scope before export or upload',async()=>{
 const r=await release({mode:'local-preview'});assert.ok(r.error,'preview archive must not reach full-app upload');assert.equal(r.calls.length,1);
});
test('full release rejects missing dSYM before export or upload',async()=>{
 const r=await release({missingDsym:true});assert.ok(r.error,'symbol-less archive must not reach upload');assert.equal(r.calls.length,1);
});
test('full release rejects an exempt-encryption declaration',async()=>{
 const r=await release({encryptedDeclaration:false});assert.ok(r.error,'full encrypted app must not be declared exempt');assert.equal(r.calls.length,1);
});
test('full release rejects a changed exported build before upload',async()=>{
 const r=await release({ipaBuild:'35'});assert.ok(r.error,'IPA must match the immutable archive');assert.equal(r.calls.length,2);
});
test('full release uploads only after matching archive and IPA audits',async()=>{
 const r=await release();assert.equal(r.error,undefined);assert.equal(r.calls.length,3);
});

test('full release rejects a signing identity for another app before export',async()=>{
 const r=await release({appIdentifier:'TESTTEAM00.other.app'});assert.ok(r.error,'signed app identity must match requested team and bundle');assert.equal(r.calls.length,1);
});
test('full release inventories hidden executable resources before export',async()=>{
 const r=await release({extraExecutable:true});assert.ok(r.error,'extra unaudited code must not reach upload');assert.equal(r.calls.length,1);
});
test('full encrypted release rejects malformed encryption metadata',async()=>{
 const r=await release({encryptedDeclaration:'NO'});assert.ok(r.error,'full app encryption flag must be Boolean true or omitted');assert.equal(r.calls.length,1);
});

test('full release rejects undefined crypto imports as static encryption evidence',async()=>{
 const r=await release({cryptoDefined:false});assert.ok(r.error,'undefined imports do not prove statically linked encryption');assert.equal(r.calls.length,1);
});
