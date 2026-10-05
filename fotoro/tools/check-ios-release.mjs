import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {iosArtifactTools as tools} from './check-ios-preview.mjs';

const requiredCrypto = ['_sodium_init','_crypto_pwhash','_crypto_sign_detached','_crypto_sign_verify_detached',
  '_crypto_aead_xchacha20poly1305_ietf_encrypt','_crypto_aead_xchacha20poly1305_ietf_decrypt',
  '_crypto_secretstream_xchacha20poly1305_init_pull','_crypto_secretstream_xchacha20poly1305_init_push',
  '_crypto_secretstream_xchacha20poly1305_pull','_crypto_secretstream_xchacha20poly1305_push'];
function fail(code) {const e=new Error(`Full app artifact audit failed: ${code}.`);e.name='ReleaseArtifactAuditError';e.code=code;throw e;}
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
  const binaries=tools.regularFiles(app).filter(tools.isMachO);
  if(binaries.length!==1||binaries[0]!==join(app,value.CFBundleExecutable))fail("UNEXPECTED_EXECUTABLE");
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
  return uuid;
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
    const uuid=identity(app,value,dsyms,teamIdentifier);
    if(ipaPath!==undefined) {
      if(typeof ipaPath!=='string'||!ipaPath)fail('INVALID_IPA_PATH');
      extracted=mkdtempSync(join(tmpdir(),'fotoro-release-audit-'));
      const exported=tools.extractIpa(realpathSync(resolve(ipaPath)),extracted);
      const exportedInfo=info(exported,buildNumber);
      if(identity(exported,exportedInfo,dsyms,teamIdentifier,{distribution:true})!==uuid)fail('IPA_BINARY_MISMATCH');
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
