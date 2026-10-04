import {AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage, env} from '@huggingface/transformers';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
env.allowLocalModels=false;
const id='Xenova/mobileclip_s0', options={revision:'20c6e4f26ad3f7f7e9cde13c4f9bb54852dd42c6',dtype:'fp32',device:'cpu'};
const [tokenizer,processor,textModel,imageModel]=await Promise.all([AutoTokenizer.from_pretrained(id,options),AutoProcessor.from_pretrained(id,options),CLIPTextModelWithProjection.from_pretrained(id,{...options,dtype:"q8"}),CLIPVisionModelWithProjection.from_pretrained(id,options)]);
const texts=['fireworks over a city at night','a dog on a beach','birthday cake'];
const tokens=tokenizer(texts,{padding:'max_length',truncation:true});
for(let i=0;i<tokens.input_ids.data.length;i++)if(tokens.attention_mask.data[i]===0n)tokens.input_ids.data[i]=0n;

const {text_embeds}=await textModel(tokens);
const image=await RawImage.read(fileURLToPath(new URL('../../../fixtures/media/singapore.jpg',import.meta.url)));
const {image_embeds}=await imageModel(await processor(image));
const a=image_embeds.normalize().tolist()[0],b=text_embeds.normalize().tolist();
assert.equal(a.length,512);assert.ok(a.every(Number.isFinite));
const scores=b.map(vector=>vector.reduce((sum,value,index)=>sum+value*a[index],0));
assert.ok(scores[0]>=.20 && scores[0]>scores[1] && scores[0]>scores[2], JSON.stringify(scores));
console.log(JSON.stringify({processor:'mobileclip_s0-textq8-imagefp32-pinned',fixture:'existing public Singapore photo',dimensions:a.length,scores,qualification:'one real inference smoke case; not held-out search accuracy or browser/device latency'}));
await textModel.dispose();await imageModel.dispose();
