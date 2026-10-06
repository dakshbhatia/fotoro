import type {LocalPhoto} from "../local/resources";
import {PeopleRuntimeUnavailable} from "./engine";
import {validatePeopleFace,type PeopleFace} from "./groups";

export async function scanPeoplePhotos(photos: readonly LocalPhoto[], signal: AbortSignal, options: {
  current:(photo:LocalPhoto)=>boolean;
  preview:(photo:LocalPhoto)=>Promise<Blob>;
  analyze:(blob:Blob)=>Promise<unknown[]>;
  progress:(completed:number,total:number)=>void;
}) {
  if(photos.length>500)throw new Error("Choose up to 500 photos to find people.");
  const faces:PeopleFace[]=[],sources=new Map<string,LocalPhoto>();let skipped=0;
  try {
    for(let index=0;index<photos.length;index++) {
      const photo=photos[index];signal.throwIfAborted();
      if(!options.current(photo))continue;
      options.progress(index+1,photos.length);
      try {
        const preview=await options.preview(photo);
        const result=await options.analyze(preview);
        signal.throwIfAborted();if(!options.current(photo))continue;
        const next=result.map(value=>validatePeopleFace(value,photo));
        if(new Set(next.map(face=>face.id)).size!==next.length)throw new Error("People result unavailable.");
        if(faces.length+next.length>2000)throw new PeopleRuntimeUnavailable("Choose fewer photos to find people.");
        faces.push(...next);sources.set(photo.id,photo);
      }catch(error) {
        signal.throwIfAborted();if(error instanceof PeopleRuntimeUnavailable)throw error;skipped++;
      }
    }
    return {faces,sources,skipped};
  }catch(error){for(const face of faces)face.vector.fill(0);throw error;}
}
