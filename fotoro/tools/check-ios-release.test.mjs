import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inflateSync} from 'node:zlib';
import {SourceTextModule,SyntheticModule} from 'node:vm';

const sourcePath=fileURLToPath(new URL('./check-ios-release.mjs',import.meta.url));
const UUID='11111111-2222-3333-4444-555555555555',ORT_UUID='D4A8DB50-9DBC-3756-9E12-47C3A4D18765';
const team='TESTTEAM12';
const crypto=['sodium_init','crypto_pwhash','crypto_sign_detached','crypto_sign_verify_detached',
  'crypto_aead_xchacha20poly1305_ietf_encrypt','crypto_aead_xchacha20poly1305_ietf_decrypt',
  'crypto_secretstream_xchacha20poly1305_init_pull','crypto_secretstream_xchacha20poly1305_init_push',
  'crypto_secretstream_xchacha20poly1305_pull','crypto_secretstream_xchacha20poly1305_push'];
const evidence=[...crypto,'OrtGetApiBase'].map((s,i)=>`${(i+1).toString(16).padStart(16,'0')} T _${s}`).join('\n');
// Unsigned Xcode 27 codeless-framework stub, with an eight-byte dummy signature.
// No certificate, signing identity or private archive data is included.
const stub=inflateSync(Buffer.from('eNrt281KAlEUwPE7lhFUJK36IHAVFKJSQS6HSFKKEhqi3WA0kZQa40i6cxO9QhtbtWjZA7TrASJo1zP0Ai2iO86RJhVq0a7/Dw6Xc+bec+9c3c7T+9vHuFKG0kZ0TOpoRJS6VDG/pGZ0XOuwbSt7YKl+5uA8KmFI2bY9p+F9TevrZ/7Qd1i1wql/rlynz3Z+Zyu7kbd61rW+5/e5YDRCZ/JNSJ/pnrrpnhe9k1S1Umm49YpXKjvJY7dYdi6q7mm42p2/qneMyX5pPaxIntb5qB4jsocp5zGlPqajoP7OnOzzcvdaaD+s7d9MbT7ePl85y7oWl3MoNduZ6b/vUOdS2qUlPcRCfRLSp/d30P8VlZFnQa/dqH9zqXrNTZ2VDv3Ya9Y8p5xcTx41dRasW5D+GXnvRcm79zEveUGeAwAAAAAAAAAAAAAAAAAAAAAAAAAAAMB/FFfB994JycPfwUd+sXaQT+b0P/g=','base64'));
const roots=[];
function binary(path,changes={}) {mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,Buffer.concat([Buffer.from([0xcf,0xfa,0xed,0xfe]),Buffer.from(JSON.stringify({uuid:UUID,arch:'arm64',nm:evidence,...changes}))]));}
function fixture({ort=true}={}) {
  const root=mkdtempSync(join(tmpdir(),'fotoro-release-test-'));roots.push(root);
  const archivePath=join(root,'build.xcarchive'),app=join(archivePath,'Products/Applications/Fotoro.app');mkdirSync(app,{recursive:true});
  const info={CFBundleIdentifier:'cloud.fotoro.Fotoro',CFBundleExecutable:'Fotoro',FotoroBuildMode:'encrypted',CFBundleVersion:'39',CFBundleShortVersionString:'1.0',ITSAppUsesNonExemptEncryption:true,MinimumOSVersion:'26.0'};
  const infoPath=join(app,'Info.plist');writeFileSync(infoPath,JSON.stringify(info));
  const executable=join(app,'Fotoro');binary(executable);
  const dsym=join(archivePath,'dSYMs/Fotoro.app.dSYM/Contents/Resources/DWARF/Fotoro');binary(dsym);
  const framework=join(app,'Frameworks/onnxruntime.framework'),ortBinary=join(framework,'onnxruntime');
  const ortInfo={CFBundleIdentifier:'com.microsoft.onnxruntime',CFBundleExecutable:'onnxruntime',CFBundlePackageType:'FMWK',CFBundleVersion:'1.24.2',CFBundleShortVersionString:'1.24.2',MinimumOSVersion:'26.0'};
  if(ort) {mkdirSync(framework,{recursive:true});writeFileSync(ortBinary,stub);writeFileSync(join(framework,'Info.plist'),JSON.stringify(ortInfo));}
  return {root,archivePath,app,info,infoPath,executable,dsym,framework,ortBinary,ortInfo,commands:[],
    entitlements:{'application-identifier':`${team}.cloud.fotoro.Fotoro`,'com.apple.developer.associated-domains':['webcredentials:fotoro.cloud','applinks:fotoro.cloud'],'get-task-allow':false}};
}
function result(stdout='',status=0) {return {stdout,stderr:status?'SECRET-DIAGNOSTIC':'',status,signal:null};}
function commands(f) {return (command,args,options={})=>{
  f.commands.push({command,args});
  if(command==='/usr/bin/plutil')return result(JSON.stringify(JSON.parse(args.at(-1)==='-'?options.input:readFileSync(args.at(-1),'utf8'))));
  if(command==='/usr/bin/codesign') {
    if(args.includes('--verify'))return result('',f.badSignature||(f.badTeam&&args.includes('-R'))?1:0);
    return result(JSON.stringify(f.entitlements));
  }
  if(command==='/usr/bin/dwarfdump') {const path=args.at(-1),m=path.endsWith('/onnxruntime')?{uuid:ORT_UUID,arch:'arm64'}:JSON.parse(readFileSync(path).subarray(4));return result(`UUID: ${m.uuid} (${m.arch}) SECRET-PATH\n`);}
  if(command==='/usr/bin/nm')return result(JSON.parse(readFileSync(args.at(-1)).subarray(4)).nm);
  if(command==='/usr/bin/zipinfo')return result(['Payload/','Payload/Fotoro.app/','Payload/Fotoro.app/Fotoro'].map(x=>`-rw-r--r-- 3.0 unx 1 bx 1 stor 26-Oct-01 00:00 ${x}`).join('\n'));
  if(command==='/usr/bin/unzip') {
    if(args.includes('-Z1'))return result('Payload/\nPayload/Fotoro.app/\nPayload/Fotoro.app/Fotoro\n');
    const target=args[args.indexOf('-d')+1];mkdirSync(join(target,'Payload'),{recursive:true});cpSync(f.app,join(target,'Payload/Fotoro.app'),{recursive:true});f.mutateIpa?.(join(target,'Payload/Fotoro.app'));return result();
  }
  throw new Error('unexpected syscall');
};}
async function load(f) {
  const cache=new Map();
  async function module(path) {
    if(cache.has(path))return cache.get(path);
    const m=new SourceTextModule(readFileSync(path,'utf8'),{identifier:pathToFileURL(path).href,initializeImportMeta(meta){meta.url=pathToFileURL(path).href;}});cache.set(path,m);
    await m.link(async specifier=>{
      if(specifier.startsWith('.'))return module(fileURLToPath(new URL(specifier,pathToFileURL(path))));
      const ns=specifier==='node:child_process'?{spawnSync:commands(f)}:await import(specifier);
      return new SyntheticModule(Object.keys(ns),function(){for(const [key,value] of Object.entries(ns))this.setExport(key,value);});
    });return m;
  }
  const m=await module(sourcePath);await m.evaluate();return m.namespace.checkIosRelease;
}
const input=f=>({archivePath:f.archivePath,buildNumber:'39',teamIdentifier:team});
const tests=[];function test(name,run){tests.push({name,run});}
async function reject(change,code,{ipa=false}={}) {
  const f=fixture();change(f);const check=await load(f);
  if(ipa)writeFileSync(join(f.root,'sample.ipa'),'fixture');
  assert.throws(()=>check({...input(f),...(ipa?{ipaPath:join(f.root,'sample.ipa')}:{})}),e=>e.code===code&&!e.message.includes('SECRET')&&!e.message.includes(f.root));
}
function mutateStub(f,mutate) {const value=Buffer.from(stub);mutate(value);writeFileSync(f.ortBinary,value);}
function commandOffset(value,wanted) {let offset=32;for(let i=0;i<value.readUInt32LE(16);i++){if(value.readUInt32LE(offset)===wanted)return offset;offset+=value.readUInt32LE(offset+4);}throw new Error('missing command');}
test('pinned empty ORT stub accepted with real runtime in main dSYM',async()=>{const f=fixture(),check=await load(f);assert.equal(check(input(f)).archiveAudited,true);assert.ok(f.commands.some(x=>x.command.endsWith('/codesign')&&x.args.includes('-R')));});
test('legacy full app without ORT remains auditable',async()=>{const f=fixture({ort:false}),check=await load(f);assert.equal(check(input(f)).matchingDsym,true);});
test('single arm64 fat container around exact stub accepted',async()=>{const f=fixture(),fat=Buffer.alloc(32+stub.length);fat.writeUInt32BE(0xcafebabe);fat.writeUInt32BE(1,4);fat.writeUInt32BE(0x0100000c,8);fat.writeUInt32BE(32,16);fat.writeUInt32BE(stub.length,20);stub.copy(fat,32);writeFileSync(f.ortBinary,fat);assert.equal((await load(f))(input(f)).archiveAudited,true);});
test('distribution signature size changes preserve unsigned stub identity',async()=>{const f=fixture(),b=Buffer.concat([stub,Buffer.alloc(64)]);b.writeUInt32LE(72,commandOffset(b,0x1d)+12);let cursor=32;for(let i=0;i<b.readUInt32LE(16);i++){if(b.readUInt32LE(cursor)===0x19&&b.toString('ascii',cursor+8,cursor+18)==='__LINKEDIT'){b.writeBigUInt64LE(0x10000n,cursor+32);b.writeBigUInt64LE(1000n,cursor+48);}cursor+=b.readUInt32LE(cursor+4);}writeFileSync(f.ortBinary,b);assert.equal((await load(f))(input(f)).archiveAudited,true);});
test('hidden executable rejected even with matching dSYM',()=>reject(f=>binary(join(f.app,'Resources/hidden.dat')),'UNEXPECTED_EXECUTABLE'));
test('unapproved framework executable rejected',()=>reject(f=>binary(join(f.app,'Frameworks/other.framework/other')),'UNEXPECTED_EXECUTABLE'));
test('ORT identity substitution rejected',()=>reject(f=>{f.ortInfo.CFBundleIdentifier='other';writeFileSync(join(f.framework,'Info.plist'),JSON.stringify(f.ortInfo));},'INVALID_ORT_IDENTITY'));
test('ORT version substitution rejected',()=>reject(f=>{f.ortInfo.CFBundleVersion='1.24.3';writeFileSync(join(f.framework,'Info.plist'),JSON.stringify(f.ortInfo));},'INVALID_ORT_IDENTITY'));
test('build39 framework declaration15.1 rejects pinned iOS26 executable before signing',()=>reject(f=>{f.ortInfo.MinimumOSVersion='15.1';writeFileSync(join(f.framework,'Info.plist'),JSON.stringify(f.ortInfo));},'INVALID_ORT_MINIMUM_OS'));
test('missing framework deployment declaration rejected',()=>reject(f=>{delete f.ortInfo.MinimumOSVersion;writeFileSync(join(f.framework,'Info.plist'),JSON.stringify(f.ortInfo));},'INVALID_ORT_MINIMUM_OS'));
test('malformed framework deployment declarations rejected',async()=>{for(const value of ['26.x','26.0suffix','26.0.0.1','',26,'26.256','65536.0'])await reject(f=>{f.ortInfo.MinimumOSVersion=value;writeFileSync(join(f.framework,'Info.plist'),JSON.stringify(f.ortInfo));},'INVALID_ORT_MINIMUM_OS');});
test('framework declaration cannot require a newer OS than the app',()=>reject(f=>{f.ortInfo.MinimumOSVersion='26.1';writeFileSync(join(f.framework,'Info.plist'),JSON.stringify(f.ortInfo));},'INVALID_ORT_MINIMUM_OS'));
test('application deployment declaration must be valid for the compatibility comparison',async()=>{for(const value of [undefined,'26.beta'])await reject(f=>{f.info.MinimumOSVersion=value;writeFileSync(f.infoPath,JSON.stringify(f.info));},'INVALID_ORT_MINIMUM_OS');});
test('deployment components are compared numerically and equivalent versions accepted',async()=>{
 const f=fixture();f.ortInfo.MinimumOSVersion='26.0.0';f.info.MinimumOSVersion='26';writeFileSync(join(f.framework,'Info.plist'),JSON.stringify(f.ortInfo));writeFileSync(f.infoPath,JSON.stringify(f.info));assert.equal((await load(f))(input(f)).archiveAudited,true);
 const newer=fixture();newer.ortInfo.MinimumOSVersion='26.2';newer.info.MinimumOSVersion='26.10';writeFileSync(join(newer.framework,'Info.plist'),JSON.stringify(newer.ortInfo));writeFileSync(newer.infoPath,JSON.stringify(newer.info));assert.equal((await load(newer))(input(newer)).archiveAudited,true);
});
test('malformed ORT executable cannot bypass optional legacy path',()=>reject(f=>writeFileSync(f.ortBinary,'invalid executable'),'INVALID_ORT_STUB'));
test('code-bearing ORT framework rejected',()=>reject(f=>mutateStub(f,b=>b.writeBigUInt64LE(4n,commandOffset(b,0x19)+112)),'INVALID_ORT_STUB'));
test('unsigned byte change rejected by fingerprint',()=>reject(f=>mutateStub(f,b=>{b[1000]=1;}),'UNRECOGNIZED_ORT_STUB'));
test('simulator platform rejected',()=>reject(f=>mutateStub(f,b=>b.writeUInt32LE(7,commandOffset(b,0x32)+8)),'INVALID_ORT_STUB'));
test('non-arm64 architecture rejected',()=>reject(f=>mutateStub(f,b=>b.writeUInt32LE(0x01000007,4)),'INVALID_ORT_ARCHITECTURE'));
test('trailing bytes outside signature rejected',()=>reject(f=>writeFileSync(f.ortBinary,Buffer.concat([stub,Buffer.from([1])])),'INVALID_ORT_STUB'));
test('wrong framework signing team rejected',()=>reject(f=>{f.badTeam=true;},'ARTIFACT_VERIFICATION_FAILED'));
test('invalid nested signature rejected',()=>reject(f=>{f.badSignature=true;},'ARTIFACT_VERIFICATION_FAILED'));
test('ORT stub cannot substitute for missing static runtime',()=>reject(f=>binary(f.dsym,{nm:evidence.replace(/^.*_OrtGetApiBase$/m,'')}),'MISSING_STATIC_ORT'));
test('existing crypto definition gate retained',()=>reject(f=>binary(f.dsym,{nm:evidence.replace(/^.*_crypto_pwhash$/m,'')}),'MISSING_STATIC_CRYPTO'));
test('existing main dSYM provenance gate retained',()=>reject(f=>binary(f.dsym,{uuid:'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'}),'MISSING_MATCHING_DSYM'));
test('artifact symlinks rejected before scanning',()=>reject(f=>symlinkSync(f.ortBinary,join(f.app,'alias')),'ARTIFACT_VERIFICATION_FAILED'));
test('identical signed IPA stub accepted',async()=>{const f=fixture(),check=await load(f);writeFileSync(join(f.root,'sample.ipa'),'fixture');assert.equal(check({...input(f),ipaPath:join(f.root,'sample.ipa')}).ipaAudited,true);});
test('IPA omitted framework cannot inherit archive audit',()=>reject(f=>{f.mutateIpa=app=>rmSync(join(app,'Frameworks'),{recursive:true});},'IPA_BINARY_MISMATCH',{ipa:true}));
test('IPA substituted framework rejected independently',()=>reject(f=>{f.mutateIpa=app=>{const b=Buffer.from(stub);b[1000]=1;writeFileSync(join(app,'Frameworks/onnxruntime.framework/onnxruntime'),b);};},'UNRECOGNIZED_ORT_STUB',{ipa:true}));
test('IPA-only stale framework declaration rejected independently of valid archive',()=>reject(f=>{f.mutateIpa=app=>{writeFileSync(join(app,'Frameworks/onnxruntime.framework/Info.plist'),JSON.stringify({...f.ortInfo,MinimumOSVersion:'15.1'}));};},'INVALID_ORT_MINIMUM_OS',{ipa:true}));
test('IPA debug entitlement still rejected',()=>reject(f=>{f.entitlements['get-task-allow']=true;},'IPA_ALLOWS_DEBUGGING',{ipa:true}));
try {for(const {name,run} of tests){await run();console.log(`PASS ${name}`);}console.log(`Passed ${tests.length} full artifact verifier tests.`);}finally{for(const root of roots)rmSync(root,{recursive:true,force:true});}
