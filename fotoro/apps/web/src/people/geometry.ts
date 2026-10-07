import type {PeopleAssignment} from "@fotoro/contracts/people";
export type Point = readonly [number, number];
export interface FaceDetection {box: [number, number, number, number]; landmarks: Point[]; score: number}
export const FACE_LANDMARKS: readonly Point[] = [[38.2946,51.6963],[73.5318,51.5014],[56.0252,71.7366],[41.5493,92.3655],[70.7299,92.2041]];
export function normalizedVector(values: ArrayLike<number>): Float32Array {
  if (values.length !== 128) throw new Error("People embedding is invalid.");
  let norm = 0;
  for (let index = 0; index < values.length; index++) {if (!Number.isFinite(values[index])) throw new Error("People embedding is invalid."); norm += values[index] ** 2;}
  if (norm < 1e-12) throw new Error("People embedding is invalid.");
  return Float32Array.from(values, value => value / Math.sqrt(norm));
}
export function cosine(left: Float32Array, right: Float32Array) {
  if (left.length !== 128 || right.length !== 128) return -1;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}
export function boxOverlap(left: readonly number[], right: readonly number[]) {
  const width = Math.max(0, Math.min(left[0] + left[2], right[0] + right[2]) - Math.max(left[0], right[0]));
  const height = Math.max(0, Math.min(left[1] + left[3], right[1] + right[3]) - Math.max(left[1], right[1]));
  const area = width * height;
  return area / Math.max(1e-8, left[2] * left[3] + right[2] * right[3] - area);
}
export function quantizedBox(box: readonly number[], width: number, height: number): PeopleAssignment["box"] {
  const left = Math.max(0, Math.min(width,box[0])), top = Math.max(0, Math.min(height,box[1]));
  const right = Math.max(left,Math.min(width,box[0]+box[2])), bottom = Math.max(top,Math.min(height,box[1]+box[3]));
  const x = Math.max(0, Math.min(9999, Math.round(left / width * 10000))), y = Math.max(0, Math.min(9999, Math.round(top / height * 10000)));
  return [x, y, Math.max(1, Math.min(10000 - x, Math.round((right-left) / width * 10000))), Math.max(1, Math.min(10000 - y, Math.round((bottom-top) / height * 10000)))];
}
// Similarity alignment mirrors OpenCV SFace's five-landmark warp, without a full CV library.
export function faceTransform(points: readonly Point[]) {
  if (points.length !== 5 || points.some(point => point.length !== 2 || point.some(value => !Number.isFinite(value)))) throw new Error("Face landmarks are unavailable.");
  const sourceMean = points.reduce((sum, point) => [sum[0] + point[0] / 5, sum[1] + point[1] / 5], [0, 0]);
  const targetMean = FACE_LANDMARKS.reduce((sum, point) => [sum[0] + point[0] / 5, sum[1] + point[1] / 5], [0, 0]);
  let denominator = 0, real = 0, imaginary = 0;
  for (let index = 0; index < 5; index++) {
    const x = points[index][0] - sourceMean[0], y = points[index][1] - sourceMean[1], u = FACE_LANDMARKS[index][0] - targetMean[0], v = FACE_LANDMARKS[index][1] - targetMean[1];
    denominator += x * x + y * y; real += x * u + y * v; imaginary += x * v - y * u;
  }
  if (denominator < 1e-6) throw new Error("Face landmarks are unavailable.");
  const a = real / denominator, b = imaginary / denominator;
  if (a * a + b * b < 1e-10) throw new Error("Face landmarks are unavailable.");
  return {a, b, x: targetMean[0] - a * sourceMean[0] + b * sourceMean[1], y: targetMean[1] - b * sourceMean[0] - a * sourceMean[1]};
}
export function alignedFaceRGB(pixels: Uint8ClampedArray, width: number, height: number, points: readonly Point[]) {
  const transform = faceTransform(points), output = new Float32Array(3 * 112 * 112), determinant = transform.a ** 2 + transform.b ** 2;
  const sample = (x: number, y: number, channel: number) => x < 0 || y < 0 || x >= width || y >= height ? 0 : pixels[(y * width + x) * 4 + channel];
  for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) {
    const dx = x - transform.x, dy = y - transform.y;
    const sx = (transform.a * dx + transform.b * dy) / determinant, sy = (-transform.b * dx + transform.a * dy) / determinant;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    for (let channel = 0; channel < 3; channel++) output[channel * 112 * 112 + y * 112 + x] =
      sample(x0, y0, channel) * (1 - fx) * (1 - fy) + sample(x0 + 1, y0, channel) * fx * (1 - fy)
      + sample(x0, y0 + 1, channel) * (1 - fx) * fy + sample(x0 + 1, y0 + 1, channel) * fx * fy;
  }
  return output;
}
export function decodeYuNet(outputs: Record<string, ArrayLike<number>>, size = 640): FaceDetection[] {
  const found: FaceDetection[] = [];
  for (const stride of [8,16,32]) {
    const columns = size / stride, count = columns * columns;
    const cls = outputs[`cls_${stride}`], object = outputs[`obj_${stride}`], boxes = outputs[`bbox_${stride}`], landmarks = outputs[`kps_${stride}`];
    if (!cls || !object || !boxes || !landmarks || cls.length !== count || object.length !== count || boxes.length !== count * 4 || landmarks.length !== count * 10) throw new Error("Face detection output is invalid.");
    for (let index = 0; index < count; index++) {
      if (!Number.isFinite(cls[index]) || !Number.isFinite(object[index])) throw new Error("Face detection output is invalid.");
      const score = Math.sqrt(Math.max(0, Math.min(1, cls[index])) * Math.max(0, Math.min(1, object[index])));
      if (score < .8) continue;
      const column = index % columns, row = Math.floor(index / columns);
      const width = Math.exp(boxes[index * 4 + 2]) * stride, height = Math.exp(boxes[index * 4 + 3]) * stride;
      const x = (column + boxes[index * 4]) * stride - width / 2, y = (row + boxes[index * 4 + 1]) * stride - height / 2;
      const points = Array.from({length:5}, (_, point) => [(landmarks[index * 10 + point * 2] + column) * stride, (landmarks[index * 10 + point * 2 + 1] + row) * stride] as const);
      if ([x,y,width,height,...points.flat()].some(value => !Number.isFinite(value)) || width <= 0 || height <= 0) throw new Error("Face detection output is invalid.");
      found.push({box:[x,y,width,height], landmarks:points, score});
    }
  }
  found.sort((a,b) => b.score - a.score);
  const kept: FaceDetection[] = [];
  for (const face of found) if (kept.every(other => boxOverlap(face.box, other.box) < .3)) kept.push(face);
  if (kept.length > 40) throw new Error("Too many faces to assess safely in one photo.");
  return kept;
}
