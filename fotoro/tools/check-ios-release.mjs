import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {iosArtifactTools as tools} from './check-ios-preview.mjs';

const requiredCrypto = ['_sodium_init','_crypto_pwhash','_crypto_sign_detached','_crypto_sign_verify_detached',
  '_crypto_aead_xchacha20poly1305_ietf_encrypt','_crypto_aead_xchacha20poly1305_ietf_decrypt',
  '_crypto_secretstream_xchacha20poly1305_init_pull','_crypto_secretstream_xchacha20poly1305_init_push',
  '_crypto_secretstream_xchacha20poly1305_pull','_crypto_secretstream_xchacha20poly1305_push'];
function fail(code) {const e=new Error(`Full app artifact audit failed: ${code}.`);e.name='ReleaseArtifactAuditError';e.code=code;throw e;}
// ORT 1.24.2 links statically into Fotoro. Xcode 27 embeds its resource
// framework with an empty arm64/iOS dylib stub, not the runtime implementation.
// Pin every unsigned byte of that stub (including UUID, platform and load
// commands). Only code-signature size fields vary during distribution signing.
const ortStubSha256='56d8eb73285a7b1cb70d21b232ce6f45e90e247aac4270ff5d7e17c49996972a';
function minimumOs(value) {
  if(typeof value!=='string'||!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(value))return;
  const parts=value.split('.').map(Number);while(parts.length<3)parts.push(0);
  if(parts[0]<1||parts[0]>65535||parts[1]>255||parts[2]>255)return;
  return parts;
}
function compareOs(a,b) {
  for(let i=0;i<3;i++)if(a[i]!==b[i])return Math.sign(a[i]-b[i]);
  return 0;
}
function ortStubFingerprint(path) {
  const file=readFileSync(path);
  let slice=file;
  if(file.readUInt32BE(0)===0xcafebabe) {
    if(file.readUInt32BE(4)!==1||file.readUInt32BE(8)!==0x0100000c)fail('INVALID_ORT_ARCHITECTURE');
    const offset=file.readUInt32BE(16),size=file.readUInt32BE(20);
    if(offset<28||offset+size!==file.length)fail('INVALID_ORT_STUB');
    slice=file.subarray(offset,offset+size);
  }
  if(slice.readUInt32LE(0)!==0xfeedfacf||slice.readUInt32LE(4)!==0x0100000c
    ||slice.readUInt32LE(12)!==6)fail('INVALID_ORT_ARCHITECTURE');
  const normalized=Buffer.from(slice),count=slice.readUInt32LE(16),commandsEnd=32+slice.readUInt32LE(20);
  let cursor=32,signatureOffset,signatureSize,platform,binaryMinimum,emptyText=false;
  for(let i=0;i<count;i++) {
    if(cursor+8>commandsEnd||commandsEnd>slice.length)fail('INVALID_ORT_STUB');
    const command=slice.readUInt32LE(cursor),size=slice.readUInt32LE(cursor+4);
    if(size<8||cursor+size>commandsEnd)fail('INVALID_ORT_STUB');
    if(command===0x1d) {
      if(size!==16||signatureOffset!==undefined)fail('INVALID_ORT_STUB');
      signatureOffset=slice.readUInt32LE(cursor+8);signatureSize=slice.readUInt32LE(cursor+12);
      normalized.fill(0,cursor+8,cursor+16);
    }
    if(command===0x32) {
      if(size<24||platform!==undefined)fail('INVALID_ORT_STUB');
      platform=slice.readUInt32LE(cursor+8);
      const packed=slice.readUInt32LE(cursor+12);
      binaryMinimum=[packed>>>16,(packed>>>8)&255,packed&255];
    }
    if(command===0x19) {
      const name=slice.toString('ascii',cursor+8,cursor+24).replace(/\0.*$/s,'');
      if(name==='__LINKEDIT') {
        normalized.fill(0,cursor+32,cursor+40);normalized.fill(0,cursor+48,cursor+56);
      }
      if(name==='__TEXT'&&size===152&&slice.readUInt32LE(cursor+64)===1) {
        emptyText=slice.toString('ascii',cursor+72,cursor+88).replace(/\0.*$/s,'')==='__text'
          &&slice.readBigUInt64LE(cursor+112)===0n;
      }
    }
    cursor+=size;
  }
  if(cursor!==commandsEnd||platform!==2||!emptyText||signatureOffset<commandsEnd
    ||signatureOffset+signatureSize!==slice.length)fail('INVALID_ORT_STUB');
  return {sha256:createHash('sha256').update(normalized.subarray(0,signatureOffset)).digest('hex'),binaryMinimum};
}
function ortIdentity(app,appInfo,teamIdentifier) {
  const framework=join(app,'Frameworks/onnxruntime.framework'),binary=join(framework,'onnxruntime');
  const value=tools.plist(join(framework,'Info.plist'));
  if(value.CFBundleIdentifier!=='com.microsoft.onnxruntime'||value.CFBundleExecutable!=='onnxruntime'
    ||value.CFBundlePackageType!=='FMWK'||value.CFBundleVersion!=='1.24.2'
    ||value.CFBundleShortVersionString!=='1.24.2')fail('INVALID_ORT_IDENTITY');
  const stub=ortStubFingerprint(binary);
  if(stub.sha256!==ortStubSha256)fail('UNRECOGNIZED_ORT_STUB');
  const frameworkMinimum=minimumOs(value.MinimumOSVersion),appMinimum=minimumOs(appInfo.MinimumOSVersion);
  if(!frameworkMinimum||!appMinimum||compareOs(frameworkMinimum,stub.binaryMinimum)<0
    ||compareOs(frameworkMinimum,appMinimum)>0)fail('INVALID_ORT_MINIMUM_OS');
  tools.runTool('codesign',['--verify','--strict',framework]);
  // Verify the nested signature independently, including its expected identity
  // and the same team as the app. Empty stubs have no source and no dSYM.
  tools.runTool('codesign',['--verify','--strict','-R',`=identifier "com.microsoft.onnxruntime" and anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`,framework]);
  return tools.uuidKey(tools.uuids(binary));
}
function info(app,buildNumber) {
  const value=tools.plist(join(app,'Info.plist'));
  if(value.CFBundleIdentifier!=='cloud.fotoro.Fotoro'||value.FotoroBuildMode!=='encrypted')fail('INVALID_FULL_APP_SCOPE');
  if(value.ITSAppUsesNonExemptEncryption!==undefined&&value.ITSAppUsesNonExemptEncryption!==true)fail('INVALID_ENCRYPTION_DECLARATION');
  if(value.CFBundleVersion!==buildNumber)fail('INVALID_BUILD_NUMBER');
  if(typeof value.CFBundleExecutable!=='string'||!value.CFBundleExecutable||/[\\/\0]/.test(value.CFBundleExecutable)
    ||['.','..'].includes(value.CFBundleExecutable))fail('INVALID_EXECUTABLE');
  return value;
}
function identity(app,value,dsyms,teamIdentifier,{distribution=false}={}) {
  // Reject links/special files and inventory every executable before native tools.
  const files=tools.regularFiles(app),binaries=files.filter(tools.isMachO);
  const main=join(app,value.CFBundleExecutable),ort=join(app,'Frameworks/onnxruntime.framework/onnxruntime');
  if(!binaries.includes(main)||binaries.some(path=>path!==main&&path!==ort))fail('UNEXPECTED_EXECUTABLE');
  if(files.some(path=>path.startsWith(join(app,'Frameworks/onnxruntime.framework')+'/'))&&!binaries.includes(ort))fail('INVALID_ORT_STUB');
  const ortUuid=binaries.includes(ort)?ortIdentity(app,value,teamIdentifier):undefined;
  tools.runTool('codesign',['--verify','--strict','--deep',app]);
  const xml=tools.runTool('codesign',['-d','--entitlements',':-',app]);
  const entitlements=JSON.parse(tools.runTool('plutil',['-convert','json','-o','-','-'],{input:xml}));
  if(entitlements['application-identifier']!==`${teamIdentifier}.cloud.fotoro.Fotoro`)fail('INVALID_SIGNED_APP_IDENTITY');
  const domains=entitlements['com.apple.developer.associated-domains'];
  if(!Array.isArray(domains)||domains.length!==2||!domains.includes('webcredentials:fotoro.cloud')
    ||!domains.includes('applinks:fotoro.cloud'))fail('INVALID_PRODUCTION_ASSOCIATION');
  if(distribution&&entitlements['get-task-allow']!==false)fail('IPA_ALLOWS_DEBUGGING');
  const uuid=tools.uuidKey(tools.uuids(join(app,value.CFBundleExecutable)));
  if(!uuid.startsWith('arm64:')||uuid.includes('|'))fail('INVALID_ARCHITECTURE');
  const dsym=dsyms.get(uuid);
  if(!dsym)fail('MISSING_MATCHING_DSYM');
  const definitions=new Set(dsym.evidence.split('\n').map(line=>line.match(/^[0-9a-f]+\s+[Tt]\s+(\S+)$/i)?.[1]).filter(Boolean));
  if(requiredCrypto.some(symbol=>!definitions.has(symbol)))fail('MISSING_STATIC_CRYPTO');
  if(ortUuid&&!definitions.has('_OrtGetApiBase'))fail('MISSING_STATIC_ORT');
  return {uuid,ortUuid};
}

// No signing or upload. Report scope explicitly; distribution requires a checked IPA.
export function checkIosRelease({archivePath,ipaPath,buildNumber,teamIdentifier}={}) {
  let extracted;
  try {
    if(typeof archivePath!=='string'||!archivePath||!/^[1-9]\d*$/.test(buildNumber??'')||!/^[A-Z0-9]{10}$/.test(teamIdentifier??''))fail('MISSING_REQUIRED_INPUT');
    const archive=realpathSync(resolve(archivePath));
    const app=tools.singleApp(join(archive,'Products/Applications'));
    const value=info(app,buildNumber);
    const dsyms=tools.readDsyms(archive,path=>tools.runTool('nm',['-a',path]));
    const archiveIdentity=identity(app,value,dsyms,teamIdentifier);
    if(ipaPath!==undefined) {
      if(typeof ipaPath!=='string'||!ipaPath)fail('INVALID_IPA_PATH');
      extracted=mkdtempSync(join(tmpdir(),'fotoro-release-audit-'));
      const exported=tools.extractIpa(realpathSync(resolve(ipaPath)),extracted);
      const exportedInfo=info(exported,buildNumber);
      if(JSON.stringify(identity(exported,exportedInfo,dsyms,teamIdentifier,{distribution:true}))!==JSON.stringify(archiveIdentity))fail('IPA_BINARY_MISMATCH');
      for(const key of ['CFBundleShortVersionString','CFBundleExecutable']) {
        if(value[key]!==exportedInfo[key])fail('IPA_METADATA_MISMATCH');
      }
    }
    return Object.freeze({mode:'encrypted',buildNumber,archiveAudited:true,ipaAudited:ipaPath!==undefined,
      matchingDsym:true,staticCryptoSymbols:requiredCrypto.length,productionAssociations:true});
  } catch(error) {
    if(error?.name==='ReleaseArtifactAuditError')throw error;
    // Never disclose raw native-tool diagnostics, operational identities or paths.
    fail('ARTIFACT_VERIFICATION_FAILED');
  } finally {
    if(extracted)try{rmSync(extracted,{recursive:true,force:true});}catch{fail('TEMP_CLEANUP_FAILED');}
  }
}
