import {imageDimensions, PHOTO_HEADER_BYTES} from "../media/photo-source";

export const CLOUD_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"] as const;
export type CloudModel = typeof CLOUD_MODELS[number];
export const CLOUD_PREVIEW_EDGE = 1024;
export const CLOUD_PREVIEW_BYTES = 512 * 1024;
export interface CloudObservation {
  version: 1;
  photoId: string;
  sourceRevision: string;
  processor: CloudModel;
  observedAt: string;
  observations: {objects: string[]; scene: string[]; visibleText: string; uncertainty: string[]};
}
export interface CloudConnection {apiBase: string; expectedAccountId: string; token?: string;}
export interface CloudPhotoBinding {photoId: string; sourceRevision: string;}
export class CloudPhotoError extends Error {}
export function observationMatches(value: CloudObservation, binding: CloudPhotoBinding) {
  return value.photoId === binding.photoId && value.sourceRevision === binding.sourceRevision;
}
export function parseCloudObservation(value: unknown, binding: CloudPhotoBinding): CloudObservation {
  const exact = (v: unknown, keys: string[]) => v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
  const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
  const list = (v: unknown, max: number, length: number) => Array.isArray(v) && v.length <= max && v.every(item => text(item, length) && item.trim());
  if (!exact(value, ["version", "photoId", "sourceRevision", "processor", "observedAt", "observations"])) throw new CloudPhotoError("CLOUD_RESULT_INVALID");
  const result = value as CloudObservation, v = result.observations;
  if (result.version !== 1 || !observationMatches(result, binding) || !CLOUD_MODELS.includes(result.processor)
    || typeof result.observedAt !== "string" || !Number.isFinite(Date.parse(result.observedAt))
    || !exact(v, ["objects", "scene", "visibleText", "uncertainty"]) || !list(v.objects, 12, 80)
    || !list(v.scene, 6, 80) || !text(v.visibleText, 1200) || !list(v.uncertainty, 4, 160)) throw new CloudPhotoError("CLOUD_RESULT_INVALID");
  return result;
}
function endpoint(connection: CloudConnection, path: string) {return connection.apiBase.replace(/\/$/, "") + "/v1/intelligence/" + path;}
function headers(connection: CloudConnection) {return {"Content-Type": "application/json", ...(connection.token ? {Authorization: "Bearer " + connection.token} : {})};}
export async function cloudCapabilities(connection: CloudConnection, signal?: AbortSignal) {
  const response = await fetch(endpoint(connection, "capabilities") + "?expectedAccountId=" + encodeURIComponent(connection.expectedAccountId), {credentials: "include", cache: "no-store", headers: headers(connection), signal});
  if (!response.ok) return false;
  const result = await response.json();
  return result?.version === 1 && result.enabled === true;
}
// A fresh JPEG removes source metadata. Never fetch originals here.
export async function prepareCloudPreview(source: Blob, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (source.type !== "image/jpeg" || source.size > 20 * 1024 * 1024) throw new CloudPhotoError("CLOUD_PREVIEW_INVALID");
  const header = new Uint8Array(await source.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
  let dimensions: {width: number; height: number} | undefined;
  try {if (header[0] === 0xff && header[1] === 0xd8) dimensions = imageDimensions(header);}
  finally {header.fill(0);}
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!dimensions || dimensions.width > 1600 || dimensions.height > 1600) throw new CloudPhotoError("CLOUD_PREVIEW_INVALID");
  const bitmap = await createImageBitmap(source);
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!bitmap.width || !bitmap.height || bitmap.width > 1600 || bitmap.height > 1600) throw new CloudPhotoError("CLOUD_PREVIEW_INVALID");
    const scale = Math.min(1, CLOUD_PREVIEW_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new CloudPhotoError("CLOUD_PREVIEW_UNAVAILABLE");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.4]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (blob?.type === "image/jpeg" && blob.size <= CLOUD_PREVIEW_BYTES) return blob;
    }
    throw new CloudPhotoError("CLOUD_PREVIEW_TOO_LARGE");
  } finally {bitmap.close();}
}
export async function observeCloudPhoto(connection: CloudConnection, binding: CloudPhotoBinding, preview: Blob,
  model: CloudModel, consent: "send-this-preview-to-google", signal?: AbortSignal): Promise<CloudObservation> {
  if (consent !== "send-this-preview-to-google") throw new CloudPhotoError("CLOUD_CONSENT_REQUIRED");
  if (preview.type !== "image/jpeg" || preview.size > CLOUD_PREVIEW_BYTES) throw new CloudPhotoError("CLOUD_PREVIEW_INVALID");
  const bytes = new Uint8Array(await preview.arrayBuffer());
  let binary = "";
  try {for (const byte of bytes) binary += String.fromCharCode(byte);} finally {bytes.fill(0);}
  const response = await fetch(endpoint(connection, "observe"), {method: "POST", credentials: "include", cache: "no-store", headers: headers(connection), signal,
    body: JSON.stringify({version: 1, expectedAccountId: connection.expectedAccountId, photoId: binding.photoId, sourceRevision: binding.sourceRevision, model, consent, preview: {mimeType: "image/jpeg", base64: btoa(binary)}})});
  binary = "";
  if (!response.ok) throw new CloudPhotoError(response.status === 429 ? "CLOUD_WORK_LIMIT" : response.status === 401 ? "CLOUD_SIGN_IN_REQUIRED" : "CLOUD_UNAVAILABLE");
  return parseCloudObservation(await response.json(), binding);
}
