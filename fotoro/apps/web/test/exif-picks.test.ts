import test from "node:test";
import assert from "node:assert/strict";
import {captureDate} from "../src/library/exif";
import {localPhoto} from "../src/local/resources";
import {recommendPhotos, type PhotoSignals} from "../src/local/auto-picks";

// Real JPEG APP1/TIFF structure: modification date in IFD0, original date in Exif IFD.
function jpeg(modified?: string, original?: string, type = 2) {
  const bytes = new Uint8Array(180), view = new DataView(bytes.buffer), base = 12;
  bytes.set([255,216,255,225]); view.setUint16(4,160);
  bytes.set(new TextEncoder().encode("Exif\0\0"),6);
  bytes.set([73,73],base); view.setUint16(base+2,42,true); view.setUint32(base+4,8,true);
  view.setUint16(base+8,Number(!!modified)+Number(!!original),true);
  let entry=base+10;
  const dateEntry=(at:number,tag:number,text:string,offset:number)=>{
    view.setUint16(at,tag,true); view.setUint16(at+2,type,true);
    view.setUint32(at+4,20,true); view.setUint32(at+8,offset,true);
    bytes.set(new TextEncoder().encode(text+"\0"),base+offset);
  };
  if(modified){dateEntry(entry,0x132,modified,90);entry+=12;}
  if(original){
    view.setUint16(entry,0x8769,true);view.setUint16(entry+2,4,true);view.setUint32(entry+4,1,true);view.setUint32(entry+8,50,true);
    view.setUint16(base+50,1,true);dateEntry(base+52,0x9003,original,112);
  }
  bytes.set([255,192,0,11,8,3,32,4,176,1,1,0x11,0,255,217],164);
  return bytes;
}
const signal:PhotoSignals={hash:0n,luminance:.5,contrast:.15,sharpness:.12,color:[120,120,120]};

test("modification-only JPEG dates never qualify exported photos as a capture burst",async()=>{
  const bytes=jpeg("2026:10:01 12:00:00");
  const photos=await Promise.all(["a","b"].map(name=>localPhoto(new File([bytes],name+".jpg",{type:"image/jpeg"}))));
  assert.equal(captureDate(bytes),undefined);
  assert.equal(photos[0].dateSource,"selected");
  assert.equal(photos[0].captureVerified,undefined);
  assert.equal(recommendPhotos(photos,new Map(photos.map(p=>[p.id,signal]))).groupCount,1); // Identical source digest.
  assert.equal(recommendPhotos(photos.map((p,i)=>({...p,id:String(i)})),new Map([["0",signal],["1",signal]])).groupCount,2);
});

test("original capture date wins over an earlier modification tag and has verified provenance",async()=>{
  const bytes=jpeg("2026:10:02 12:00:00","2026:09:01 11:00:00");
  const photo=await localPhoto(new File([bytes],"camera.jpg",{type:"image/jpeg"}));
  const expected=new Date("2026-09-01T11:00:00").toISOString();
  assert.equal(photo.date,expected);assert.equal(photo.captureVerified,true);
  assert.equal(captureDate(bytes),expected);
});

test("valid capture clocks survive browser DST gaps while retaining existing local date display",()=>{
  const previous=process.env.TZ;
  try {
    for(const zone of ["America/New_York","UTC","Asia/Kolkata"]){
      process.env.TZ=zone;
      assert.equal(captureDate(jpeg(undefined,"2026:03:08 02:30:00")),new Date("2026-03-08T02:30:00").toISOString());
      assert.equal(new Date(captureDate(jpeg(undefined,"2026:09:01 02:30:00"))!).getDate(),1);
      assert.equal(captureDate(jpeg(undefined,"2026:02:31 11:00:00")),undefined);
    }
  } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test("legacy EXIF provenance and invalid original tags cannot qualify as verified bursts",()=>{
  const base={filename:"legacy.jpg",date:"2026-10-01T12:00:00Z",dateSource:"exif" as const,width:1200,height:800};
  assert.equal(recommendPhotos([{...base,id:"a"},{...base,id:"b"}],new Map([["a",signal],["b",signal]])).groupCount,2);
  assert.equal(captureDate(jpeg(undefined,"2026:02:31 11:00:00")),undefined);
  assert.equal(captureDate(jpeg(undefined,"2026:09:01 11:00:00",4)),undefined);
});
