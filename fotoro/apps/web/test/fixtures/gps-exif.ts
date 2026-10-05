export function gpsTiff({little = true, latitudeRef = "N", longitudeRef = "E", clock = "2026:09:01 11:00:00", offset = "+05:30"} = {}) {
  const bytes = new Uint8Array(244), view = new DataView(bytes.buffer);
  const u16 = (at: number, value: number) => view.setUint16(at, value, little);
  const u32 = (at: number, value: number) => view.setUint32(at, value, little);
  const entry = (at: number, tag: number, type: number, size: number, value: number) => {
    u16(at, tag); u16(at + 2, type); u32(at + 4, size); u32(at + 8, value);
  };
  bytes.set(little ? [73, 73] : [77, 77]); u16(2, 42); u32(4, 8);
  u16(8, 2); entry(10, 0x8769, 4, 1, 40); entry(22, 0x8825, 4, 1, 80);
  u16(40, 2); entry(42, 0x9003, 2, 20, 160); entry(54, 0x9011, 2, 7, 180);
  bytes.set(new TextEncoder().encode(clock + "\0"), 160);
  bytes.set(new TextEncoder().encode(offset + "\0"), 180);
  u16(80, 4); entry(82, 1, 2, 2, 0); entry(94, 2, 5, 3, 188);
  entry(106, 3, 2, 2, 0); entry(118, 4, 5, 3, 212);
  bytes.set(new TextEncoder().encode(latitudeRef + "\0"), 90);
  bytes.set(new TextEncoder().encode(longitudeRef + "\0"), 114);
  for (const [at, values] of [[188, [41, 54, 1008]], [212, [12, 29, 4704]]] as const)
    values.forEach((value, i) => {u32(at + i * 8, value); u32(at + i * 8 + 4, i === 2 ? 100 : 1);});
  return bytes;
}
export function gpsJpeg(tiff = gpsTiff()) {
  const bytes = new Uint8Array(tiff.length + 27), view = new DataView(bytes.buffer);
  bytes.set([255, 216, 255, 225]); view.setUint16(4, tiff.length + 8);
  bytes.set(new TextEncoder().encode("Exif\0\0"), 6); bytes.set(tiff, 12);
  bytes.set([255, 192, 0, 11, 8, 3, 32, 4, 176, 1, 1, 0x11, 0, 255, 217], tiff.length + 12);
  return bytes;
}
export function gpsHeifPayload(tiff = gpsTiff()) {
  const bytes = new Uint8Array(tiff.length + 4); bytes.set(tiff, 4); return bytes;
}
