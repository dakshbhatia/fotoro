import {downloadOriginal, type ShareEnvironment} from "../library/system-share";
import type {LocalPhoto} from "./resources";

export async function shareSelectedOriginals(photos: readonly LocalPhoto[], current: () => boolean, environment: ShareEnvironment = {
  canShare: data => navigator.canShare?.(data) ?? false,
  share: data => navigator.share(data),
  download: downloadOriginal,
}): Promise<"shared" | "downloaded" | "cancelled"> {
  const files = photos.flatMap(photo => photo.file instanceof File ? [photo.file] : []);
  if (!files.length || files.length !== photos.length || !current()) throw new Error("Reselect every chosen original before sharing.");
  let supported = false;
  try {supported = typeof environment.share === "function" && environment.canShare?.({files}) === true;} catch {}
  if (supported) {
    try {await environment.share!({files}); return "shared";}
    catch (error) {if ((error as Error).name === "AbortError") return "cancelled"; throw error;}
  }
  for (const file of files) {
    if (!current()) throw new Error("The photo selection changed.");
    environment.download(file);
  }
  return "downloaded";
}
