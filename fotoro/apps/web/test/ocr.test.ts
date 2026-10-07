import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalOcrQueue, localOcrOptions, OCR_PROCESSOR, hasCurrentLocalOcr, currentOcrSource, localTextSearchStatus, type OcrWorker } from '../src/local/ocr';
import type {LocalPhoto} from '../src/local/resources';
const preview = async () => {const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);const view=new DataView(bytes.buffer);view.setUint32(16,1600);view.setUint32(20,1000);return {blob:new Blob([bytes],{type:'image/png'}),width:1600,height:1000};};
const deferred = <T>() => {let resolve!: (value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve};};
const worker = (recognize:OcrWorker['recognize'],terminate=async()=>{}) => ({recognize,terminate});

test('OCR coverage requires current photo, revision and processor, while reopened sources may be scheduled again', () => {
 const source: LocalPhoto = {id:'photo',digest:'revision',filename:'photo.jpg',date:'2026-10-06',dateSource:'selected',file:new File(['public fixture'],'photo.jpg')};
 const complete = {...source,ocr:{photoID:'photo',revision:'revision',processor:OCR_PROCESSOR,status:'complete' as const,text:'RECEIPT',confidence:.9}};
 assert.equal(hasCurrentLocalOcr(complete),true);
 for(const stale of [{...complete,ocr:{...complete.ocr,photoID:'other'}},{...complete,ocr:{...complete.ocr,revision:''}},
  {...complete,ocr:{...complete.ocr,processor:'previous-model'}},{...complete,ocr:{...complete.ocr,confidence:NaN}},
  {...complete,digest:'replacement'},{...complete,current:()=>false}]) assert.equal(hasCurrentLocalOcr(stale),false);
 assert.equal(currentOcrSource(source,[{...source,caption:'User caption'}]),true);
 assert.equal(currentOcrSource(source,[{...source,file:new File(['reopened'],'photo.jpg')}]),false);
 assert.equal(currentOcrSource(source,[{...source,digest:'replacement'}]),false);
 assert.equal(currentOcrSource(source,[{...source,current:()=>false}]),false);
 assert.equal(localTextSearchStatus([source],true,'receipt'),'indexing');
 assert.equal(localTextSearchStatus([complete],true,'receipt'),undefined);
 assert.equal(localTextSearchStatus([{...source,previewAvailable:false}],true,'receipt'),'incomplete');
 const failed = {...complete,ocr:{...complete.ocr,status:'failed' as const,text:'',confidence:0}};
 assert.equal(localTextSearchStatus([failed],true,'receipt'),'incomplete');
 assert.equal(localTextSearchStatus([failed],true,'receipt',undefined,true),'indexing','An explicit retry must describe active reading rather than a finished failure');
 assert.equal(localTextSearchStatus([{...failed,ocr:{...failed.ocr,revision:'old'}}],true,'receipt'),'indexing','A failure from an older revision must not suppress a current attempt');
 for(const query of ['', 'today','2026-10-06']) assert.equal(localTextSearchStatus([source],true,query),undefined);
 assert.equal(localTextSearchStatus([source],true,'family','label:family'),undefined);
 assert.equal(localTextSearchStatus([source],true,'family 2026-10-06','dated:'+JSON.stringify([null,null,'label:family'])),undefined);
 assert.equal(localTextSearchStatus([{...source,dateSource:'exif',date:'2026-10-05'}],true,'receipt 2026-10-06'),undefined,'Unread photos outside the capture period cannot delay this query');
 assert.equal(localTextSearchStatus([{...source,dateSource:'exif',date:new Date(2026,9,6,12).toISOString()}],true,'receipt 2026-10-06'),'indexing');
 assert.equal(localTextSearchStatus([source],false,'receipt'),undefined);
});

test('replacing a same-ID preview source while OCR waits suppresses the old completion', async () => {
 const source: LocalPhoto = {id:'photo',digest:'revision',filename:'photo.jpg',date:'2026-10-06',dateSource:'selected',file:new File(['first'],'photo.jpg')};
 let latest = [source], created = 0;
 const held = deferred<{blob:Blob;width:number;height:number}>();
 const queue = new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>{created++; return worker(async()=>({data:{text:'obsolete',confidence:95}}));}});
 const pending = queue.recognize(source.id,source.digest!,()=>held.promise,()=>currentOcrSource(source,latest));
 await Promise.resolve();
 latest = [{...source,file:new File(['replacement'],'photo.jpg')}];
 held.resolve(await preview());
 assert.equal(await pending,undefined); assert.equal(created,0);
 await queue.cancel();
});

test('OCR runtime worker/core/language paths are explicitly same-origin and language caching stores no trial data',()=>{
 const options=localOcrOptions('https://fotoro.example');
 for(const path of [options.workerPath,options.corePath,options.langPath])assert.equal(new URL(path).origin,'https://fotoro.example');
 assert.equal(options.workerBlobURL,false);assert.equal(options.cacheMethod,'none');
 assert.throws(()=>localOcrOptions('https://fotoro.example/path'),/origin/);
 assert.throws(()=>localOcrOptions('data:text/plain,remote'),/origin/);
});
test('serial OCR reuses one worker and tags recognized text with photo revision and processor',async()=>{
 let active=0,peak=0,created=0,terminated=0;
 const queue=new LocalOcrQueue({origin:'http://127.0.0.1:4310',createWorker:async()=>{created++;return worker(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return {data:{text:'  INVOICE 4826\n',confidence:94}};},async()=>{terminated++})}});
 const results=await Promise.all([queue.recognize('a','sha-a',preview),queue.recognize('b','sha-b',preview)]);
 assert.equal(peak,1);assert.equal(created,1);
 assert.deepEqual(results[0],{photoID:'a',revision:'sha-a',status:'complete',text:'  INVOICE 4826\n',confidence:.94,processor:OCR_PROCESSOR});
 assert.equal(results[1]?.photoID,'b');await queue.cancel();assert.equal(terminated,1);
});
test('clear cancels in-flight recognition and queued jobs without emitting a late completion',async()=>{
 const result=deferred<{data:{text:string;confidence:number}}>();let started=false,terminated=0,previewReads=0;
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>worker(async()=>{started=true;return result.promise},async()=>{terminated++})});
 const first=queue.recognize('old','revision',preview);
 const second=queue.recognize('queued','revision',async()=>{previewReads++;return preview()});
 while(!started)await new Promise(r=>setTimeout(r,0));await queue.cancel();
 assert.equal(await first,undefined);assert.equal(await second,undefined);assert.equal(terminated,1);assert.equal(previewReads,0);
 result.resolve({data:{text:'stale Ronald',confidence:99}});
 await new Promise(r=>setTimeout(r,0));assert.equal(await first,undefined);
});
test('cancellation during worker initialization terminates the eventual worker before a new generation starts',async()=>{
 const initialized=deferred<OcrWorker>();let creations=0,recognized=0,terminated=0;
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>{creations++;return creations===1?initialized.promise:worker(async()=>({data:{text:'fresh',confidence:80}}))}});
 const old=queue.recognize('old','r',preview);
 while(!creations)await new Promise(r=>setTimeout(r,0));const cleared=queue.cancel();
 const fresh=queue.recognize('fresh','r',preview);
 initialized.resolve(worker(async()=>{recognized++;return {data:{text:'old',confidence:99}}},async()=>{terminated++}));
 await cleared;assert.equal(await old,undefined);assert.equal((await fresh)?.text,'fresh');assert.equal(recognized,0);assert.equal(terminated,1);await queue.cancel();
});
test('a stale source revision is fenced after preview loading and after OCR',async()=>{
 const held=deferred<{blob:Blob;width:number;height:number}>();let current=true,created=0;
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>{created++;return worker(async()=>({data:{text:'obsolete',confidence:95}}))}});
 const pending=queue.recognize('a','old',()=>held.promise,()=>current);current=false;held.resolve(await preview());
 assert.equal(await pending,undefined);assert.equal(created,0);await queue.cancel();
 const recognized=deferred<{data:{text:string;confidence:number}}>();let entered=false;current=true;
 const next=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>worker(async()=>{entered=true;return recognized.promise})});
 const stale=next.recognize('a','old',preview,()=>current);
 while(!entered)await new Promise(r=>setTimeout(r,0));current=false;recognized.resolve({data:{text:'old',confidence:95}});
 assert.equal(await stale,undefined);await next.cancel();
});
test('missing, oversized and unsupported previews fail honestly before worker creation',async()=>{
 let created=0;
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>{created++;return worker(async()=>({data:{text:'invented',confidence:100}}))}});
 const missing=await queue.recognize('missing','r',async()=>{throw new Error('Preview unavailable')});
 assert.equal(missing?.status,'failed');assert.equal(missing?.text,'');assert.match(missing?.error??'',/Preview unavailable/);
 const large=await queue.recognize('large','r',async()=>({...await preview(),width:1601}));assert.equal(large?.status,'failed');
 const unsupported=await queue.recognize('format','r',async()=>({...await preview(),blob:new Blob(['x'],{type:'image/heic'})}));assert.equal(unsupported?.status,'failed');
 assert.equal(created,0);await queue.cancel();
});
test('worker failure leaves partial coverage and next job can recover using a new worker',async()=>{
 let count=0,terminated=0;
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>{count++;return worker(async()=>{if(count===1)throw new Error('Unreadable OCR');return {data:{text:'RECEIPT',confidence:90}}},async()=>{terminated++})}});
 const failure=await queue.recognize('bad','r',preview);assert.equal(failure?.status,'failed');assert.equal(failure?.text,'');
 const good=await queue.recognize('good','r',preview);assert.equal(good?.text,'RECEIPT');assert.equal(terminated,1);await queue.cancel();
});
test('empty OCR output completes without invented matches and progress never escapes a cancelled generation',async()=>{
 const logs:string[]=[];let log!: (event:{status:string;progress:number})=>void;
 const queue=new LocalOcrQueue({origin:'http://localhost',onProgress:p=>logs.push(p.photoID+':'+p.status),createWorker:async options=>{log=options.logger;return worker(async()=>{log({status:'recognizing text',progress:.5});return {data:{text:'',confidence:0}}})}});
 const result=await queue.recognize('blank','r',preview);assert.equal(result?.status,'complete');assert.equal(result?.text,'');
 await queue.cancel();const before=logs.length;log({status:'late',progress:1});assert.equal(logs.length,before);
});

test('reused worker progress is attributed to the current photo',async()=>{
 const logs:string[]=[];let log!: (event:{status:string;progress:number})=>void;
 const queue=new LocalOcrQueue({origin:'http://localhost',onProgress:p=>{if(p.status==='recognizing text')logs.push(p.photoID)},createWorker:async options=>{log=options.logger;return worker(async()=>{log({status:'recognizing text',progress:.5});return {data:{text:'receipt',confidence:90}}})}});
 await queue.recognize('first','r',preview);await queue.recognize('second','r',preview);
 assert.deepEqual(logs,['first','second']);await queue.cancel();
});
test('real protocol host terminates an initializing native worker immediately on cancellation',async()=>{
 const { createLocalOcrWorker }=await import('../src/local/ocr');
 let stopped=0;
 const native={postMessage() {},terminate(){stopped++},onmessage:null,onerror:null} as unknown as Worker;
 const controller=new AbortController();
 const initialized=createLocalOcrWorker(localOcrOptions('http://localhost'),controller.signal,()=>native);
 controller.abort();await assert.rejects(initialized,{name:'AbortError'});assert.equal(stopped,1);
});
test('real protocol host fails language loading honestly and terminates its native worker',async()=>{
 const { createLocalOcrWorker }=await import('../src/local/ocr');
 let stopped=0;
 const native={onmessage:null as any,onerror:null as any,terminate(){stopped++},postMessage(message:any){queueMicrotask(()=>native.onmessage({data:{...message,status:message.action==='loadLanguage'?'reject':'resolve',data:message.action==='loadLanguage'?'Language unavailable':{loaded:true}}}))}} as unknown as Worker;
 await assert.rejects(createLocalOcrWorker(localOcrOptions('http://localhost'),new AbortController().signal,()=>native),/Language unavailable/);
 assert.equal(stopped,1);
});

test('native protocol replies must match both job and action before recognized output is accepted',async()=>{
 const {createLocalOcrWorker}=await import('../src/local/ocr');
 const native={onmessage:null as any,onerror:null as any,onmessageerror:null as any,terminate(){},postMessage(message:any){queueMicrotask(()=>{
  const result=message.action==='recognize'?{text:'RECEIPT',confidence:95}:{loaded:true};
  native.onmessage({data:{...message,jobId:'foreign',status:'resolve',data:{text:'WRONG',confidence:100}}});
  native.onmessage({data:{...message,action:'foreign',status:'resolve',data:{text:'WRONG',confidence:100}}});
  native.onmessage({data:{...message,workerId:'foreign',status:'resolve',data:{text:'WRONG',confidence:100}}});
  native.onmessage({data:{...message,status:'resolve',data:result}});
 })}} as unknown as Worker;
 const engine=await createLocalOcrWorker(localOcrOptions('http://localhost'),new AbortController().signal,()=>native);
 assert.deepEqual((await engine.recognize((await preview()).blob,{rotateAuto:true})).data,{text:'RECEIPT',confidence:95});await engine.terminate();
});
for(const phase of ['loadLanguage','initialize'])test('cancel during '+phase+' destroys native worker and rejects initialization',async()=>{
 const {createLocalOcrWorker}=await import('../src/local/ocr');const controller=new AbortController();let stopped=0;
 const native={onmessage:null as any,onerror:null as any,onmessageerror:null as any,terminate(){stopped++},postMessage(message:any){queueMicrotask(()=>{if(message.action===phase)controller.abort();else native.onmessage({data:{...message,status:'resolve',data:{loaded:true}}})})}} as unknown as Worker;
 await assert.rejects(createLocalOcrWorker(localOcrOptions('http://localhost'),controller.signal,()=>native),{name:'AbortError'});assert.equal(stopped,1);
});
for(const failure of ['onerror','onmessageerror'])test('native '+failure+' rejects recognition rather than hanging the serial queue',async()=>{
 const {createLocalOcrWorker}=await import('../src/local/ocr');let stopped=0;
 const native={onmessage:null as any,onerror:null as any,onmessageerror:null as any,terminate(){stopped++},postMessage(message:any){queueMicrotask(()=>{if(message.action==='recognize')(native as any)[failure]({message:'Worker crashed'});else native.onmessage({data:{...message,status:'resolve',data:{loaded:true}}})})}} as unknown as Worker;
 const engine=await createLocalOcrWorker(localOcrOptions('http://localhost'),new AbortController().signal,()=>native);
 await assert.rejects(engine.recognize((await preview()).blob,{rotateAuto:true}),failure==='onerror'?/Worker crashed/:/unreadable data/);assert.equal(stopped,1);
});
test('worker host rejects mixed-origin paths before spawning',async()=>{
 const {createLocalOcrWorker}=await import('../src/local/ocr');
 const options={...localOcrOptions('http://localhost'),langPath:'https://external.example/lang'};
 await assert.rejects(createLocalOcrWorker(options,new AbortController().signal,()=>{throw new Error('Should not spawn')}),/current origin/);
});


test('OCR rejects oversized actual preview headers even if caller reports bounded dimensions',async()=>{
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>worker(async()=>({data:{text:'should not run',confidence:99}}))});
 const bytes=new Uint8Array(await (await preview()).blob.arrayBuffer());new DataView(bytes.buffer).setUint32(16,2000);
 const result=await queue.recognize('large','r',async()=>({blob:new Blob([bytes],{type:'image/png'}),width:1600,height:1000}));
 assert.equal(result?.status,'failed');assert.equal(result?.text,'');await queue.cancel();
});

test('low-quality nonempty OCR tries bounded quarter-turns and keeps the strongest recognized orientation',async()=>{
 const angles:number[]=[];
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>worker(async(_blob,options)=>{
  const angle=(options as any).rotateRadians??0;angles.push(angle);
  if(angle===Math.PI)return {data:{text:'BOARDING PASS\nBOSTON\nGATE TWELVE',confidence:95}};
  return {data:{text:'SSVd ONIddVO4d',confidence:26}};
 })});
 const result=await queue.recognize('rotated','r',preview);
 assert.equal(result?.text,'BOARDING PASS\nBOSTON\nGATE TWELVE');assert.equal(result?.confidence,.95);
 assert.deepEqual(angles,[0,Math.PI/2,Math.PI,Math.PI*1.5]);assert.match(result?.processor??'',/orientation-v2/);await queue.cancel();
});
test('unreadable low-quality text is failed with empty text after all orientations rather than indexed as matches',async()=>{
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>worker(async()=>({data:{text:'unreadable junk',confidence:26}}))});
 const result=await queue.recognize('bad','r',preview);
 assert.equal(result?.status,'failed');assert.equal(result?.text,'');assert.equal(result?.confidence,0);assert.match(result?.error??'',/reliably/);await queue.cancel();
});
test('cancel during an orientation attempt stops fallback and fences late recognition',async()=>{
 const held=deferred<{data:{text:string;confidence:number}}>();let attempts=0;
 const queue=new LocalOcrQueue({origin:'http://localhost',createWorker:async()=>worker(async()=>{attempts++;return attempts===1?{data:{text:'junk',confidence:26}}:held.promise})});
 const result=queue.recognize('rotated','r',preview);
 for(let i=0;i<100&&attempts<2;i++)await new Promise(r=>setTimeout(r,1));assert.equal(attempts,2,'orientation fallback must start');await queue.cancel();assert.equal(await result,undefined);
 held.resolve({data:{text:'stale match',confidence:99}});await new Promise(r=>setTimeout(r,0));assert.equal(attempts,2);
});

test('a Clear triggered by progress cannot spawn an obsolete worker or poison the next generation',async()=>{
 let created=0,cleared=false;let queue!:LocalOcrQueue;
 queue=new LocalOcrQueue({origin:'http://localhost',onProgress:event=>{if(!cleared&&event.status==='Starting local text recognition'){cleared=true;void queue.cancel();}},createWorker:async()=>{created++;return worker(async()=>({data:{text:'fresh receipt',confidence:95}}))}});
 assert.equal(await queue.recognize('old','r',preview),undefined);assert.equal(created,0);
 assert.equal((await queue.recognize('fresh','r',preview))?.text,'fresh receipt');assert.equal(created,1);await queue.cancel();
});
