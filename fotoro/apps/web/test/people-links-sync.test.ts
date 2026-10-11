import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64, unwrapKey, verifyPayload, signPayload, utf8, wrapKey} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {clearAccount, all} from "../src/exchange/cache";
import {savePersonLink, peopleLinksState, syncPeopleLinks, resolvePeopleLinksConflict} from "../src/exchange/people-links";
import type {TripPersonLinkV1, SignedPayloadV1} from "@fotoro/contracts";
const owner = "11111111-1111-4111-8111-111111111111";
async function open() {
 await ready; const secret=accounts.testSecrets[0];
 configureVault({version:1,accountCard:{...accounts.accounts[0],accountId:owner},wrappers:[{version:1,wrapperId:crypto.randomUUID(),kind:"recovery",credentialId:null,prfSalt:null,verified:true,wrappedBundle:secret.encryptedBundle}]} as any);
 return unlockVault({kind:"recovery",secret:unb64(secret.recoverySecret)});
}
const link = (name="Dad"):TripPersonLinkV1 => ({id:crypto.randomUUID(),origin:"https://fotoro.cloud",albumId:crypto.randomUUID(),ownerCard:accounts.accounts[0],name,aliases:[{card:accounts.accounts[0],name:"Papa"},{card:accounts.accounts[1],name:"Dad"}],deleted:false});
const reply=(peopleLinks:SignedPayloadV1|null)=>new Response(JSON.stringify({version:1,peopleLinks}));
function server() {
 const remote={stored:null as SignedPayloadV1|null,puts:[] as SignedPayloadV1[],lost:false};
 globalThis.fetch=(async (_path,init)=>{if(init?.method==="PUT"){remote.stored=JSON.parse(String(init.body));remote.puts.push(remote.stored!);if(remote.lost){remote.lost=false;throw new TypeError("Lost reply");}}return reply(remote.stored);}) as typeof fetch;
 return remote;
}
async function scoped(run:(session:Awaited<ReturnType<typeof open>>)=>Promise<void>) {
 const old=globalThis.fetch;await clearAccount(owner);
 try {await run(await open());}finally {globalThis.fetch=old;lockVault();await clearAccount(owner);}
}
const signedBook=(session:Awaited<ReturnType<typeof open>>,revision:number,links:TripPersonLinkV1[],accountId=owner)=>signPayload("account-people-links",accountId,utf8({version:1,revision,encrypted:wrapKey(utf8({version:1,ownerAccountId:owner,links}),session.vaultKey)}),session.signingSecretKey);
test("private linked names sync encrypted and hydrate an empty same-account device",()=>scoped(async session=>{
 const remote=server(),value=link("家族 🐈");await savePersonLink(value);await syncPeopleLinks(session);
 assert.ok(remote.stored);assert.doesNotMatch(JSON.stringify(remote.stored),/家族|Papa|boxPublicKey/);
 const update=JSON.parse(new TextDecoder().decode(verifyPayload(remote.stored!,unb64(session.card.signingPublicKey))));
 const plain=unwrapKey(update.encrypted,session.vaultKey);try {assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)).links,[value]);}finally{plain.fill(0);}
 assert.doesNotMatch(JSON.stringify(await all("settings")),/家族|Papa|boxPublicKey/);
 await clearAccount(owner);await syncPeopleLinks(session);assert.deepEqual((await peopleLinksState()).book.links,[value]);
}));
test("lost response retries identical signed ciphertext and preserves a newer local edit",()=>scoped(async session=>{
 const remote=server(),value=link();await savePersonLink(value);remote.lost=true;await assert.rejects(syncPeopleLinks(session),/Lost reply/);
 await savePersonLink({...value,name:"Newest"});await syncPeopleLinks(session);
 assert.deepEqual(remote.puts[0],remote.puts[1]);assert.equal(remote.puts.length,3);assert.equal((await peopleLinksState()).book.links[0].name,"Newest");
}));
test("concurrent whole-book conflict stays sticky until exact explicit review",()=>scoped(async session=>{
 const remote=server(),value=link();await savePersonLink(value);await syncPeopleLinks(session);
 await savePersonLink({...value,name:"Mine"});remote.stored=signedBook(session,2,[{...value,name:"Synced"}]);
 await syncPeopleLinks(session);await syncPeopleLinks(session);
 const review=(await peopleLinksState()).conflicts[0];assert.ok(review);assert.equal(review.local.links[0].name,"Mine");assert.equal(review.remote.links[0].name,"Synced");
 await assert.rejects(resolvePeopleLinksConflict({...review,remote:{...review.remote,links:[]}},"remote"),/REVIEW_CHANGED/);
 await resolvePeopleLinksConflict(review,"remote");await syncPeopleLinks(session);assert.equal((await peopleLinksState()).book.links[0].name,"Synced");
 await savePersonLink({...value,deleted:true},{},(await peopleLinksState()).book.links[0]);await syncPeopleLinks(session);
 assert.equal((await peopleLinksState()).book.links[0].deleted,true);
}));
for(const withdrawal of ["current","origin","vault"] as const) test(`delayed linked-name refresh cannot publish after ${withdrawal} withdrawal`,()=>scoped(async session=>{
 const oldLocation=globalThis.location;Object.defineProperty(globalThis,"location",{configurable:true,value:{origin:"https://fotoro.cloud"}});
 let release!:(response:Response)=>void,current=true;
 globalThis.fetch=(async()=>new Promise<Response>(resolve=>{release=resolve;})) as typeof fetch;
 try {
  const refreshing=syncPeopleLinks(session,{current:()=>current}), rejected=assert.rejects(refreshing,withdrawal==="vault"?/VAULT_LOCKED/:{name:"AbortError"});
  while(!release) await new Promise(resolve=>setTimeout(resolve,0));
  if(withdrawal==="current")current=false;else if(withdrawal==="origin")Object.defineProperty(globalThis,"location",{configurable:true,value:{origin:"https://changed.test"}});else lockVault();
  release(reply(signedBook(session,1,[link()])));await rejected;
 }finally {Object.defineProperty(globalThis,"location",{configurable:true,value:oldLocation});}
}));
test("wrong-owner signed ledger and changed upload receipt cannot be accepted",()=>scoped(async session=>{
 globalThis.fetch=(async()=>reply(signedBook(session,1,[link()],accounts.accounts[1].accountId))) as typeof fetch;
 await assert.rejects(syncPeopleLinks(session),/OWNER_MISMATCH/);
 const remote=server();await savePersonLink(link());globalThis.fetch=(async(_path,init)=>init?.method==="PUT"?reply(signedBook(session,1,[link("Changed")])):reply(remote.stored)) as typeof fetch;
 await assert.rejects(syncPeopleLinks(session),/RECEIPT_MISMATCH/);assert.equal((await peopleLinksState()).pending,true);
}));

test("concurrent encrypted transactions retain independent links and Keep mine resolves only the reviewed conflict",()=>scoped(async session=>{
 const remote=server(),first=link(),second=link("Sister");second.aliases=second.aliases.map(alias=>({...alias,name:alias.name+" sister"}));
 await Promise.all([savePersonLink(first),savePersonLink(second)]);await syncPeopleLinks(session);
 assert.equal((await peopleLinksState()).book.links.length,2);
 await savePersonLink({...first,name:"Mine"});remote.stored=signedBook(session,2,[{...first,name:"Remote"},second]);await syncPeopleLinks(session);
 const review=(await peopleLinksState()).conflicts[0],puts=remote.puts.length;await syncPeopleLinks(session);assert.equal(remote.puts.length,puts);
 await resolvePeopleLinksConflict(review,"local");await syncPeopleLinks(session);
 assert.equal((await peopleLinksState()).book.links.find(item=>item.id===first.id)?.name,"Mine");
 const tombstone={...first,name:"Mine",deleted:true};await savePersonLink(tombstone,{},(await peopleLinksState()).book.links.find(item=>item.id===first.id));
 remote.lost=true;await assert.rejects(syncPeopleLinks(session));await syncPeopleLinks(session);
 assert.deepEqual(remote.puts.at(-1),remote.puts.at(-2));
 assert.equal((await peopleLinksState()).book.links.find(item=>item.id===first.id)?.deleted,true);
}));
test("an aborted delayed refresh leaves no remote linked names in encrypted local storage",()=>scoped(async session=>{
 let release!:(response:Response)=>void;globalThis.fetch=(async()=>new Promise<Response>(resolve=>{release=resolve;})) as typeof fetch;
 const controller=new AbortController(),refreshing=syncPeopleLinks(session,{signal:controller.signal}),rejected=assert.rejects(refreshing,{name:"AbortError"});
 while(!release)await new Promise(resolve=>setTimeout(resolve,0));controller.abort();release(reply(signedBook(session,1,[link()])));await rejected;
 assert.deepEqual((await peopleLinksState()).book.links,[]);
}));
