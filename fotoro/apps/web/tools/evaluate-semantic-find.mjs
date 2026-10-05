import {AutoTokenizer, AutoProcessor, CLIPModel, RawImage, env} from '@huggingface/transformers';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
env.allowLocalModels=false;
const id='onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX', options={revision:'9463a9c508a344c837ffefe9d724f3827bf2dc79',dtype:'q8',device:'cpu'};
env.remotePathTemplate=`{model}/resolve/${options.revision}/`;
const [tokenizer,processor,model]=await Promise.all([AutoTokenizer.from_pretrained(id,options),AutoProcessor.from_pretrained(id,options),CLIPModel.from_pretrained(id,options)]);
const texts=['fireworks over a city at night','a dog on a beach','birthday cake'];
const tokens=tokenizer(texts,{padding:'max_length',max_length:77,truncation:true});
for(let i=0;i<tokens.input_ids.data.length;i++)if(tokens.attention_mask.data[i]===0n)tokens.input_ids.data[i]=0n;

const image=await RawImage.read(fileURLToPath(new URL('../../../fixtures/media/singapore.jpg',import.meta.url)));
const {text_embeds,image_embeds}=await model({...tokens,...await processor(image)});
const a=image_embeds.normalize().tolist()[0],b=text_embeds.normalize().tolist();
assert.equal(a.length,512);assert.ok(a.every(Number.isFinite));
const scores=b.map(vector=>vector.reduce((sum,value,index)=>sum+value*a[index],0));
assert.ok(scores[0]>=.25 && scores[1]<.25 && scores[2]<.25, JSON.stringify(scores));
console.log(JSON.stringify({processor:'tinyclip-8m16-text3m-q8-pinned',fixture:'existing public Singapore photo',dimensions:a.length,scores,qualification:'one real inference smoke case; not held-out search accuracy or browser/device latency'}));
await model.dispose();
