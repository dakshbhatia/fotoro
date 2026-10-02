import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SourceTextModule, SyntheticModule } from 'node:vm';

const sourcePath = fileURLToPath(new URL('./check-ios-preview.mjs', import.meta.url));
const UUID = '11111111-2222-3333-4444-555555555555';
const OTHER_UUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const controls = 'RecentPhotosView SearchIndex GRDB';
const fixtureRoots = [];
function binary(path, overrides = {}) {
  mkdirSync(join(path, '..'), {recursive:true});
  writeFileSync(path, Buffer.concat([Buffer.from([0xcf,0xfa,0xed,0xfe]), Buffer.from(JSON.stringify({uuid:UUID, arch:'arm64', nm:controls, strings:controls, ...overrides}))]));
}
function meta(path) { return JSON.parse(readFileSync(path).subarray(4).toString()); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'fotoro-preview-test-')); fixtureRoots.push(root);
  const archivePath = join(root,'build.xcarchive');
  const app = join(archivePath,'Products/Applications/Fotoro.app');
  mkdirSync(app,{recursive:true});
  const info = {CFBundleIdentifier:'cloud.fotoro.Fotoro',CFBundleExecutable:'Fotoro',FotoroBuildMode:'local-preview',ITSAppUsesNonExemptEncryption:false};
  const infoPath = join(app,'Info.plist'); writeFileSync(infoPath,JSON.stringify(info));
  const executable = join(app,'Fotoro'); binary(executable);
  const dsym = join(archivePath,'dSYMs/Fotoro.app.dSYM/Contents/Resources/DWARF/Fotoro'); binary(dsym);
  const linkMapPath = join(root,'map.txt');
  writeFileSync(linkMapPath, `# Path: ${executable}\n# Arch: arm64\n# Object files:\n[  0] linker synthesized\n[  1] /objects/RecentPhotosView.o\n[  2] /objects/SearchIndex.o\n[  3] /objects/GRDB.o\n# Sections:\n# Address Size Segment Section\n0x100000000 0x100 __TEXT __text\n# Symbols:\n# Address Size File Name\n0x100000000 0x10 [  1] _$s6Fotoro16RecentPhotosViewV\n0x100000010 0x10 [  2] _$s6Fotoro11SearchIndexC\n0x100000020 0x10 [  3] _$s4GRDB8DatabaseC\n# Dead Stripped Symbols:\n`);
  return {root,archivePath,app,info,infoPath,executable,dsym,linkMapPath,entitlements:{'application-identifier':'SECRET-IDENTIFIER'},commands:[]};
}
function result(stdout='',stderr='',status=0){return {stdout,stderr,status,signal:null,error:undefined};}
function mockCommands(f) {
  return function(command,args,options={}) {
    f.commands.push({command,args});
    if(f.failTool && command.endsWith(f.failTool)) return result('',`SECRET-IDENTIFIER ${f.root}`,1);
    if(command==='/usr/bin/plutil') {
      const input = args.at(-1)==='-' ? options.input : readFileSync(args.at(-1),'utf8');
      try {return result(JSON.stringify(JSON.parse(input)));} catch {return result('', 'secret bad plist',1);}
    }
    if(command==='/usr/bin/dwarfdump') {
      const m=meta(args.at(-1)); return result(`UUID: ${m.uuid} (${m.arch}) SECRET-BINARY-PATH\n`);
    }
    if(command==='/usr/bin/nm') {const m=meta(args.at(-1));return result(m.nm,m.nm?'':'nm: SECRET-BINARY-PATH: no symbols\n',m.nm?0:1);}
    if(command==='/usr/bin/strings') return result(meta(args.at(-1)).strings);
    if(command==='/usr/bin/codesign') return args.includes('--verify') ? result() : result(JSON.stringify(f.entitlements));
    if(command==='/usr/bin/zipinfo') return result((f.zipEntries??['Payload/','Payload/Fotoro.app/','Payload/Fotoro.app/Fotoro']).map(x=>`${f.zipSymlink?'l':'-'}rw-r--r-- 3.0 unx 1 bx 1 stor 26-Oct-01 00:00 ${x}`).join('\n'));
    if(command==='/usr/bin/unzip') {
      if(args.includes('-Z1')) return result((f.zipEntries??['Payload/','Payload/Fotoro.app/','Payload/Fotoro.app/Fotoro']).join('\n')+'\n');
      const target=args[args.indexOf('-d')+1]; mkdirSync(join(target,'Payload'),{recursive:true});cpSync(f.app,join(target,'Payload/Fotoro.app'),{recursive:true});
      if(f.mutateIpa) f.mutateIpa(join(target,'Payload/Fotoro.app'));
      return result();
    }
    throw new Error(`Unexpected syscall ${command}`);
  };
}
async function load(f) {
  const source=readFileSync(sourcePath,'utf8');
  const module=new SourceTextModule(source,{identifier:pathToFileURL(sourcePath).href,initializeImportMeta(meta){meta.url=pathToFileURL(sourcePath).href;}});
  await module.link(async specifier=>{
    const namespace=specifier==='node:child_process'?{spawnSync:mockCommands(f)}:await import(specifier);
    const synthetic=new SyntheticModule(Object.keys(namespace),function(){for(const [key,value] of Object.entries(namespace))this.setExport(key,value);});
    return synthetic;
  });
  await module.evaluate(); return module.namespace.checkIosPreview;
}
const tests=[];
function test(name,run){tests.push({name,run});}
async function rejection(change,code,{ipa=false}={}){
  const f=fixture();change(f);
  const check=await load(f);
  let error;
  try{check({archivePath:f.archivePath,linkMapPath:f.linkMapPath,...(ipa?{ipaPath:join(f.root,'sample.ipa')}:{})});}catch(e){error=e;}
  assert.ok(error,'expected audit rejection'); assert.equal(error.code,code);
  assert.ok(!error.message.includes('SECRET')&&!error.message.includes(f.root)&&!error.message.includes(UUID),'errors must not disclose raw diagnostics');
}
test('archive happy path returns explicit unaudited IPA scope',async()=>{
  const f=fixture(); const check=await load(f); const result=check({archivePath:f.archivePath,linkMapPath:f.linkMapPath});
  assert.equal(result.ipaAudited,false);assert.equal(result.archiveMachOCount,1);assert.equal(result.dsymCount,1);assert.equal(result.mode,'local-preview');
  assert.ok(!JSON.stringify(result).includes(UUID));
  assert.ok(f.commands.some(c=>c.command==='/usr/bin/nm'));assert.ok(f.commands.some(c=>c.command==='/usr/bin/strings'));
});
test('missing artifacts fail safely',async()=>{const f=fixture();const check=await load(f);assert.throws(()=>check({}),e=>e.code==='MISSING_REQUIRED_PATHS');});
test('wrong bundle rejected',()=>rejection(f=>{f.info.CFBundleIdentifier='elsewhere';writeFileSync(f.infoPath,JSON.stringify(f.info));},'INVALID_BUNDLE_ID'));
test('missing preview marker rejected',()=>rejection(f=>{delete f.info.FotoroBuildMode;writeFileSync(f.infoPath,JSON.stringify(f.info));},'INVALID_BUILD_MODE'));
test('encryption flag must be Boolean false',()=>rejection(f=>{f.info.ITSAppUsesNonExemptEncryption='false';writeFileSync(f.infoPath,JSON.stringify(f.info));},'INVALID_ENCRYPTION_DECLARATION'));
test('forbidden nm symbol rejected',()=>rejection(f=>binary(f.executable,{nm:`${controls} _crypto_aead_xchacha20poly1305_ietf_encrypt`}), 'FORBIDDEN_BINARY_EVIDENCE'));
test('stripped crypto still rejected by executable strings',()=>rejection(f=>binary(f.executable,{nm:'',strings:`${controls} Clibsodium`}), 'FORBIDDEN_BINARY_EVIDENCE'));
test('forbidden dSYM evidence rejected',()=>rejection(f=>binary(f.dsym,{strings:`${controls} CryptoAdapter.swift`}), 'FORBIDDEN_BINARY_EVIDENCE'));
test('forbidden link map dead-stripped object rejected',()=>rejection(f=>writeFileSync(f.linkMapPath,readFileSync(f.linkMapPath,'utf8')+'<<dead>> [ 4] _sodium_init\n'), 'FORBIDDEN_LINK_MAP_EVIDENCE'));
test('extra nested Mach-O is inventoried and rejected without its dSYM',()=>rejection(f=>binary(join(f.app,'Resources/hidden.dat'),{uuid:OTHER_UUID}), 'MISSING_MATCHING_DSYM'));
test('matching extra Mach-O cannot inherit main positive controls',()=>rejection(f=>{binary(join(f.app,'Resources/hidden.dat'),{uuid:OTHER_UUID,nm:'innocent',strings:'innocent'});binary(join(f.archivePath,'dSYMs/hidden.dSYM/Contents/Resources/DWARF/hidden'),{uuid:OTHER_UUID,nm:'innocent',strings:'innocent'});}, 'UNEXPECTED_MACHO'));
test('mismatched dSYM UUID rejected',()=>rejection(f=>binary(f.dsym,{uuid:OTHER_UUID}), 'MISSING_MATCHING_DSYM'));
test('empty nm alone does not reject valid stripped binary',async()=>{const f=fixture();binary(f.executable,{nm:''});const check=await load(f);assert.equal(check({archivePath:f.archivePath,linkMapPath:f.linkMapPath}).archiveMachOCount,1);});
test('tool failures cannot become clean scans',()=>rejection(f=>{f.failTool='strings';},'TOOL_STRINGS_FAILED'));
test('artifact positives required independently of dSYM and map',()=>rejection(f=>binary(f.executable,{nm:'other',strings:'other'}),'MISSING_BINARY_POSITIVE_CONTROL'));
test('live link map positives required',()=>rejection(f=>writeFileSync(f.linkMapPath,readFileSync(f.linkMapPath,'utf8').replace('_$s6Fotoro11SearchIndexC','unrelated')), 'MISSING_LINK_MAP_POSITIVE_CONTROL'));
test('fixture resources rejected',()=>rejection(f=>writeFileSync(join(f.app,'crypto-v1.json'),'{}'),'FORBIDDEN_RESOURCE'));
test('associated domains rejected',()=>rejection(f=>{f.entitlements['com.apple.developer.associated-domains']=['applinks:secret.example'];},'FORBIDDEN_ENTITLEMENT'));
test('background Info modes rejected',()=>rejection(f=>{f.info.UIBackgroundModes=['processing'];writeFileSync(f.infoPath,JSON.stringify(f.info));},'FORBIDDEN_BACKGROUND_CONFIGURATION'));
test('symlink resources rejected before traversal',async()=>{const f=fixture();const {symlinkSync}=await import('node:fs');symlinkSync(f.root,join(f.app,'escape'));const check=await load(f);assert.throws(()=>check({archivePath:f.archivePath,linkMapPath:f.linkMapPath}),e=>e.code==='SYMLINK_IN_ARTIFACT');});
test('IPA audited via extraction with identical UUIDs',async()=>{const f=fixture();const ipaPath=join(f.root,'sample.ipa');writeFileSync(ipaPath,'zipfixture');const check=await load(f);const report=check({archivePath:f.archivePath,linkMapPath:f.linkMapPath,ipaPath});assert.equal(report.ipaAudited,true);assert.equal(report.ipaMachOCount,1);assert.ok(f.commands.some(c=>c.command==='/usr/bin/unzip'&&c.args.includes('-q')));});
test('IPA traversal rejected before extraction',()=>rejection(f=>{writeFileSync(join(f.root,'sample.ipa'),'zipfixture');f.zipEntries=['../outside'];},'UNSAFE_IPA_ENTRY',{ipa:true}));
test('IPA symlinks rejected before extraction',()=>rejection(f=>{writeFileSync(join(f.root,'sample.ipa'),'zipfixture');f.zipSymlink=true;},'SYMLINK_IN_IPA',{ipa:true}));
test('IPA binary change rejected against archive dSYM provenance',()=>rejection(f=>{writeFileSync(join(f.root,'sample.ipa'),'zipfixture');f.mutateIpa=app=>binary(join(app,'Fotoro'),{uuid:OTHER_UUID});},'MISSING_MATCHING_DSYM',{ipa:true}));
try {
  let passed=0;
  for(const {name,run} of tests){await run();passed++;process.stdout.write(`PASS ${name}\n`);}
  process.stdout.write(`Passed ${passed} artifact verifier tests.\n`);
} finally {for(const root of fixtureRoots)rmSync(root,{recursive:true,force:true});}
