export interface ShareEnvironment {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
  download: (file: File) => void;
}
export function downloadOriginal(file: File) {
  const url = URL.createObjectURL(file), link = document.createElement("a");
  link.href = url; link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function canShareOriginal(file: File, environment: Pick<ShareEnvironment, "canShare" | "share"> = navigator) {
  try {return typeof environment.share === "function" && environment.canShare?.({files: [file]}) === true;} catch {return false;}
}
/* Call with a verified original from a fresh user gesture; no asynchronous preparation precedes share(). */
export async function shareOriginal(file: File, current: () => boolean, environment: ShareEnvironment = {
  canShare: data => navigator.canShare?.(data) ?? false,
  share: data => navigator.share(data),
  download: downloadOriginal,
}): Promise<"shared" | "downloaded" | "cancelled"> {
  if (!current()) throw new Error("SOURCE_UNAVAILABLE");
  if (canShareOriginal(file, environment)) {
    try {await environment.share!({files: [file]}); return "shared";}
    catch (error) {if ((error as Error).name === "AbortError") return "cancelled"; throw error;}
  }
  environment.download(file);
  return "downloaded";
}
