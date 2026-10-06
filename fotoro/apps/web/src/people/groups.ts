import {validatedPeopleAssignments, type PeopleAssignment} from "@fotoro/contracts/people";
import type {LocalPhoto} from "../local/resources";
import {boxOverlap, cosine, normalizedVector} from "./geometry";
export interface PeopleFace {id: string; photoID: string; digest: string; box: PeopleAssignment["box"]; vector: Float32Array; score: number}
export interface PersonGroup {id: string; name?: string; faceIDs: string[]}
export function peopleSourceCurrent(original: LocalPhoto, latest: LocalPhoto | undefined, acknowledgedOwnEdit = false) {
  return !!latest && !!original.digest && latest.digest === original.digest && latest.id === original.id
    && (original.id.startsWith("saved:") && !original.file && !latest.file
      ? original.width === latest.width && original.height === latest.height
      : latest.file === original.file && latest.preview === original.preview && latest.previewLoader === original.previewLoader)
    && (acknowledgedOwnEdit || original.current?.() !== false) && latest.current?.() !== false;
}
// Like Ente's People layer, automatic clusters stay local; naming promotes only a reviewed group.
// Existing names seed exact source/face assignments, never guessed identities for unseen faces.
export function groupPeopleFaces(faces: readonly PeopleFace[], photos: readonly LocalPhoto[], uuid = () => crypto.randomUUID()): PersonGroup[] {
  const byPhoto = new Map(photos.map(photo => [photo.id,photo])), groups: PersonGroup[] = [], byID = new Map(faces.map(face => [face.id,face]));
  for (const face of faces) {
    const photo = byPhoto.get(face.photoID);
    const named = photo && validatedPeopleAssignments(photo.facts, face.digest).find(item => boxOverlap(item.box, face.box) > .6);
    if (named) {
      const previous = groups.find(group => group.id === named.personId);
      if (previous && previous.name === named.name) previous.faceIDs.push(face.id);
      else groups.push({id:previous?uuid():named.personId,name:named.name,faceIDs:[face.id]});
      continue;
    }
    const candidates = groups.filter(group => !group.name && group.faceIDs.every(id => byID.get(id)?.photoID !== face.photoID)).map(group => ({group,
      similarity: Math.min(...group.faceIDs.map(id => cosine(face.vector,byID.get(id)!.vector)))})).sort((a,b)=>b.similarity-a.similarity);
    const best = candidates[0];
    if (best && best.similarity >= .55 && (!candidates[1] || best.similarity-candidates[1].similarity >= .08)) best.group.faceIDs.push(face.id);
    else groups.push({id:uuid(),faceIDs:[face.id]});
  }
  return groups;
}
export function validatePeopleFace(value: unknown, photo: LocalPhoto): PeopleFace {
  const item = value as {box?: number[]; vector?: Float32Array; score?: number};
  if (!item || !photo.digest || !Array.isArray(item.box) || item.box.length !==4 || item.box.some(value=>!Number.isInteger(value)||value<0||value>10000)
    || item.box[2]<=0 || item.box[3]<=0 || item.box[0]+item.box[2]>10000 || item.box[1]+item.box[3]>10000 || !(item.vector instanceof Float32Array)
    || typeof item.score!=="number" || !Number.isFinite(item.score) || item.score<.8 || item.score>1) throw new Error("People result unavailable.");
  return {id:photo.id+":"+item.box.join(","),photoID:photo.id,digest:photo.digest,box:item.box as PeopleFace["box"],vector:normalizedVector(item.vector),score:item.score};
}
export function assignmentsForCorrection(photos: readonly LocalPhoto[], faces: readonly PeopleFace[], previous: readonly PersonGroup[], next: readonly PersonGroup[]) {
  const changedIDs = new Set([...previous,...next].flatMap(group=>group.faceIDs)), byID = new Map(faces.map(face=>[face.id,face]));
  const affected = new Set([...changedIDs].map(id=>byID.get(id)?.photoID));
  return photos.filter(photo=>affected.has(photo.id)).map(photo=> {
    if (!photo.digest) throw new Error("People require the original digest.");
    const changed = faces.filter(face=>face.photoID===photo.id && changedIDs.has(face.id));
    const assignments = validatedPeopleAssignments(photo.facts,photo.digest).filter(item=>!changed.some(face=>boxOverlap(face.box,item.box)>.6));
    for (const group of next) if (group.name) for (const id of group.faceIDs) {
      const face=byID.get(id); if (face?.photoID===photo.id) assignments.push({personId:group.id,name:group.name,box:face.box});
    }
    return {photo,assignments};
  });
}
