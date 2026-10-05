import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64, b64, sodium, wrapKey} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault, requireVault, encryptPrivate, vaultGeneration} from "../src/vault/vault";
import {sameVault} from "../src/vault/scope";
import {ChosenSaveIntent} from "../src/exchange/chosen-save";
import {atomic, clearAccount} from "../src/exchange/cache";
import {pendingImports} from "../src/exchange/journal";
import {refreshSync, saveSync} from "../src/exchange/sync";
import {syncSelectedSequential} from "../src/exchange/selected";
import {prepareEnrollment, completeEnrollment, cancelEnrollment, recover} from "../src/vault/session";
import {formatFotoroPassword} from "../src/vault/password";
import type {LocalPhoto} from "../src/local/resources";

const owner="55555555-5555-4555-8555-555555555555", other="66666666-6666-4666-8666-666666666666";
const secret=accounts.testSecrets[0];
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const page=()=>({version:1,mediaVersion:1,changes:[],nextCursor:"1",hasMore:false});
const sessionResponse=()=>({version:1,accountId:owner,deviceId:crypto.randomUUID(),expiresAt:new Date(Date.now()+300_000).toISOString()});
const vault=()=>({version:1,accountCard:{...accounts.accounts[0],accountId:owner},wrappers:[{version:1,wrapperId:crypto.randomUUID(),kind:"recovery",credentialId:null,prfSalt:null,verified:true,wrappedBundle:secret.encryptedBundle}]});
const photo=(name="chosen.jpg"):LocalPhoto=>({id:name,file:new File([new Uint8Array([1,2,3,4])],name,{type:"image/jpeg"}),filename:name,date:"2026-10-02",dateSource:"selected",labels:["chosen"]});
async function open(accountId=owner){configureVault({...vault(),accountCard:{...accounts.accounts[0],accountId}} as any);return unlockVault({kind:"recovery",secret:unb64(secret.recoverySecret)});}
async function scoped(run:()=>Promise<void>){
  const oldFetch=globalThis.fetch, descriptors=["navigator","location","window"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{onLine:true}});
  Object.defineProperty(globalThis,"location",{configurable:true,value:{origin:"https://fotoro.cloud"}});
  Object.defineProperty(globalThis,"window",{configurable:true,value:new EventTarget()});
  await ready;lockVault();await clearAccount(owner);await clearAccount(other);
  try{await run();}finally{cancelEnrollment();lockVault();await clearAccount(owner);await clearAccount(other);globalThis.fetch=oldFetch;for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
}
async function queued(){
  const session=requireVault(),bytes=new Uint8Array([1,2,3,4]),operationId=crypto.randomUUID(),photoId=crypto.randomUUID(),stagingKey=owner+":chosen-original";
  const item={operationId,photoId,stagingKeys:[stagingKey],sourceFilename:"chosen.jpg",sourceDigest:b64(sodium.crypto_hash_sha256(bytes)),state:"queued",wrapped:wrapKey(new Uint8Array(32),session.vaultKey),parts:[{binding:{version:1,photoId,representationId:crypto.randomUUID(),kind:"original"},header:b64(new Uint8Array(24)),ciphertextBytes:bytes.length,ciphertextSha256:b64(sodium.crypto_hash_sha256(bytes)),uploadOperation:crypto.randomUUID()}]};
  await atomic([{store:"staging",key:stagingKey,value:bytes},{store:"journal",key:owner+":"+operationId,value:encryptPrivate(item)}]);
  return item;
}
function saveOptions(intent:ChosenSaveIntent,save:(...args:Parameters<Parameters<ChosenSaveIntent["start"]>[0]["save"]>)=>Promise<boolean>){const session=requireVault();return{active:true,busy:false,session,current:()=>sameVault(session),save};}
function finishAuth(intent:ChosenSaveIntent,ticket:ReturnType<ChosenSaveIntent["beginAuthentication"]>){const session=requireVault();intent.finishAuthentication(ticket,{session,generation:vaultGeneration(),current:()=>sameVault(session)});}

test("chosen Save survives password authentication with its exact File snapshot and runs only once",async()=>scoped(async()=>{
  const first=photo(),selection=[first],intent=new ChosenSaveIntent(selection),calls:{path:string;method:string}[]=[];
  selection.push(photo("not-chosen.jpg"));first.labels!.push("later edit");
  assert.deepEqual(intent.snapshot.files,[first.file]);assert.deepEqual(intent.snapshot.photos[0].labels,["chosen"]);
  let launches=0;
  assert.equal(await intent.start({active:true,busy:false,session:{} as any,current:()=>true,save:async()=>{launches++;return true;}}),false);
  const ticket=intent.beginAuthentication(vaultGeneration());
  window.addEventListener("fotoro-lock",()=>intent.vaultLocked());
  globalThis.fetch=(async(path,init)=>{
    calls.push({path:String(path),method:init?.method??"GET"});
    if(path==="/v1/auth/recovery/options")return response({version:1,challengeId:crypto.randomUUID(),challenge:b64(sodium.randombytes_buf(32)),expiresAt:new Date(Date.now()+300_000).toISOString(),vault:vault()});
    if(path==="/v1/auth/recovery/verify")return response(sessionResponse());
    if(String(path).startsWith("/v1/changes?"))return response(page());
    if(path==="/v1/uploads/reserve")return response({version:1,code:"UNAVAILABLE"},503);
    throw new Error("Unexpected request "+path);
  }) as typeof fetch;
  await recover(formatFotoroPassword(owner,unb64(secret.recoverySecret)));
  const session=requireVault();finishAuth(intent,ticket);await queued();
  await refreshSync(session);assert.equal(calls.filter(call=>call.path==="/v1/uploads/reserve").length,0,"authentication and activation read only");
  const options=saveOptions(intent,async(snapshot,signal,current)=>{launches++;assert.ok(current());assert.deepEqual(snapshot.files,[first.file]);await saveSync(session,signal);return true;});
  assert.equal(await intent.start(options),true);assert.equal(await intent.start(options),false);
  await refreshSync(session);assert.equal(launches,1);assert.equal(calls.filter(call=>call.path==="/v1/uploads/reserve"&&call.method==="POST").length,1);
}));

test("chosen Save waits for new-account password completion while ordinary account browsing stays read-only",async()=>scoped(async()=>{
  const intent=new ChosenSaveIntent([photo()]),ticket=intent.beginAuthentication(vaultGeneration()),calls:string[]=[];
  window.addEventListener("fotoro-lock",()=>intent.vaultLocked());
  globalThis.fetch=(async(path,init)=>{
    calls.push((init?.method??"GET")+" "+path);
    if(path==="/v1/auth/start/options")return response({version:1,accountId:owner,challengeId:crypto.randomUUID(),challenge:b64(sodium.randombytes_buf(32)),expiresAt:new Date(Date.now()+300_000).toISOString()});
    if(path==="/v1/auth/start/verify")return response(sessionResponse());
    if(String(path).startsWith("/v1/changes?"))return response(page());
    if(path==="/v1/uploads/reserve")return response({version:1,code:"UNAVAILABLE"},503);
    throw new Error("Unexpected request "+path);
  }) as typeof fetch;
  const password=await prepareEnrollment();assert.match(password,/^foto_/);assert.equal(intent.boundVault,undefined);
  await completeEnrollment();const session=requireVault();finishAuth(intent,ticket);await queued();
  await refreshSync(session);await refreshSync(session);
  assert.equal(calls.filter(call=>call.includes("/v1/uploads/reserve")).length,0);
  await intent.start(saveOptions(intent,async(_snapshot,signal)=>{await saveSync(session,signal);return true;}));
  assert.equal(calls.filter(call=>call==="POST /v1/uploads/reserve").length,1);
}));

test("busy or rejected Save starts preserve the original request; concurrent activation cannot duplicate it",async()=>scoped(async()=>{
  await open();const intent=new ChosenSaveIntent([photo()],requireVault());let starts=0,release:(accepted:boolean)=>void=()=>{};
  const launch=saveOptions(intent,async()=>{starts++;return new Promise<boolean>(resolve=>{release=resolve;});});
  assert.equal(await intent.start({...launch,busy:true}),false);assert.equal(intent.pending,true);assert.equal(starts,0);
  assert.equal(intent.needsInitialSave,true);
  assert.equal(await intent.start({...launch,save:async()=>false}),false);assert.equal(intent.pending,true);
  assert.equal(intent.needsInitialSave,false,"an incomplete attempt waits for explicit Retry");
  await assert.rejects(intent.start({...launch,save:async()=>{throw new Error("activation rejected");}}),/activation rejected/);assert.equal(intent.pending,true);
  const running=intent.start(launch);assert.equal(await intent.start(launch),false);release(true);assert.equal(await running,true);assert.equal(starts,1);
  assert.equal(await intent.start(launch),false);assert.equal(starts,1);
}));

test("an unresolved upload preserves the chosen files for explicit Retry without starting the next photo",async()=>scoped(async()=>{
  const session=await open(),item=await queued(),chosen=photo("next-chosen.jpg"),intent=new ChosenSaveIntent([chosen],session);
  const staged:File[]=[],requests:string[]=[];
  globalThis.fetch=(async(path,init)=>{
    requests.push((init?.method??"GET")+" "+path);
    if(String(path).startsWith("/v1/changes?"))return response(page());
    if(path==="/v1/uploads/reserve")return response({version:1,code:"UNAVAILABLE"},503);
    throw new Error("Unexpected request "+path);
  }) as typeof fetch;
  const launch=saveOptions(intent,async(snapshot,signal,current)=>{
    const result=await syncSelectedSequential([...snapshot.files],{
      signal,current,stage:async(file)=>{staged.push(file);},
      drain:()=>saveSync(session,signal),unresolved:async()=> (await pendingImports()).some(upload=>upload.state!=="committed"),
      skipped:async(_file,error)=>{throw error;},
    });
    return !result.stopped;
  });
  assert.equal(await intent.start(launch),false);
  assert.equal(intent.pending,true);assert.equal(intent.needsInitialSave,false);
  assert.deepEqual(staged,[]);assert.deepEqual(intent.snapshot.files,[chosen.file]);
  assert.equal(requests.filter(request=>request==="POST /v1/uploads/reserve").length,1);
  await refreshSync(session);
  assert.equal(requests.filter(request=>request==="POST /v1/uploads/reserve").length,1,"background refresh does not retry uploads");
  await atomic([{store:"journal",key:owner+":"+item.operationId},{store:"staging",key:item.stagingKeys[0]}]);
  assert.equal(await intent.start(launch),true,"explicit Retry resumes the exact selection after prior work reconciles");
  assert.deepEqual(staged,[chosen.file]);assert.equal(intent.pending,false);
}));

test("an initially unlocked account binds the chosen Save directly without another confirmation",async()=>scoped(async()=>{
  const session=await open(),intent=new ChosenSaveIntent([photo()]);intent.bindInitialVault(session);let starts=0;
  assert.equal(await intent.start(saveOptions(intent,async()=>{starts++;return true;})),true);assert.equal(starts,1);
  assert.equal(await intent.start(saveOptions(intent,async()=>{starts++;return true;})),false);assert.equal(starts,1);
}));

test("a rejected password keeps the same chosen Save for a successful password retry",async()=>scoped(async()=>{
  const intent=new ChosenSaveIntent([photo()]),password=formatFotoroPassword(owner,unb64(secret.recoverySecret));
  let ticket=intent.beginAuthentication(vaultGeneration());
  globalThis.fetch=(async()=>response({version:1,code:"NOT_FOUND"},404)) as typeof fetch;
  let rejection:unknown;try{await recover(password);}catch(error){rejection=error;}
  assert.ok(rejection);intent.finishAuthentication(ticket,undefined,rejection);assert.equal(intent.pending,true);
  ticket=intent.beginAuthentication(vaultGeneration());window.addEventListener("fotoro-lock",()=>intent.vaultLocked());
  globalThis.fetch=(async(path)=>path==="/v1/auth/recovery/options"?response({version:1,challengeId:crypto.randomUUID(),challenge:b64(sodium.randombytes_buf(32)),expiresAt:new Date(Date.now()+300_000).toISOString(),vault:vault()}):response(sessionResponse())) as typeof fetch;
  await recover(password);finishAuth(intent,ticket);let starts=0;
  assert.equal(await intent.start(saveOptions(intent,async(snapshot)=>{starts++;assert.equal(snapshot.files[0].name,"chosen.jpg");return true;})),true);assert.equal(starts,1);
}));

test("Back, background or storage cancellation before auth completion cannot start a late Save",async()=>scoped(async()=>{
  for(const reason of["Back","background","storage"]){
    lockVault();const intent=new ChosenSaveIntent([photo()]),ticket=intent.beginAuthentication(vaultGeneration());intent.cancel();
    await open();finishAuth(intent,ticket);let writes=0;
    assert.equal(await intent.start(saveOptions(intent,async()=>{writes++;return true;})),false,reason);assert.equal(writes,0,reason);
  }
}));

test("a cancelled chosen Save waiting behind catalog activation makes no upload request and preserves the original",async()=>scoped(async()=>{
  const session=await open(),item=await queued(),intent=new ChosenSaveIntent([photo()],session);let started=false,release:(response:Response)=>void=()=>{};const methods:string[]=[];
  globalThis.fetch=(async(_path,init)=>{methods.push(init?.method??"GET");started=true;return new Promise<Response>(resolve=>{release=resolve;});}) as typeof fetch;
  const reading=refreshSync(session);while(!started)await new Promise(resolve=>setTimeout(resolve,0));
  const saving=intent.start(saveOptions(intent,async(_snapshot,signal)=>{await saveSync(session,signal);return true;}));
  const rejected=assert.rejects(saving,{name:"AbortError"});intent.cancel();release(response(page()));await reading;await rejected;
  assert.deepEqual(methods,["GET"]);assert.deepEqual(await pendingImports(),[item]);assert.equal(intent.snapshot.files.length,1);
}));

test("locking or switching the account cancels a bound selection without writes to the new account",async()=>scoped(async()=>{
  await open();const intent=new ChosenSaveIntent([photo()],requireVault());window.addEventListener("fotoro-lock",()=>intent.vaultLocked());
  const newer=await open(other);let writes=0;
  assert.equal(await intent.start({...saveOptions(intent,async()=>{writes++;return true;}),session:newer}),false);assert.equal(writes,0);assert.equal(requireVault(),newer);
  lockVault();const pending=new ChosenSaveIntent([photo()]),ticket=pending.beginAuthentication(vaultGeneration());lockVault();await open(other);finishAuth(pending,ticket);
  assert.equal(await pending.start(saveOptions(pending,async()=>{writes++;return true;})),false);assert.equal(writes,0);
}));
