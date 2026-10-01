/** Minimal bounded JPEG EXIF reader. Missing/invalid dates retain import provenance. */
export function captureDate(bytes: Uint8Array): string | undefined {
  try {
    if (bytes[0] !== 255 || bytes[1] !== 216) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) return;
      const marker = bytes[offset + 1];
      if (marker === 218 || marker === 217) return;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return;
      if (
        marker === 225 &&
        new TextDecoder().decode(bytes.subarray(offset + 4, offset + 10)) ===
          "Exif\0\0"
      ) {
        const base = offset + 10,
          end = offset + 2 + length;
        const little = view.getUint16(base) === 0x4949;
        if (!little && view.getUint16(base) !== 0x4d4d) return;
        const u16 = (p: number) => {
          if (p < base || p + 2 > end) throw Error();
          return view.getUint16(p, little);
        };
        const u32 = (p: number) => {
          if (p < base || p + 4 > end) throw Error();
          return view.getUint32(p, little);
        };
        if (u16(base + 2) !== 42) return;
        const parse = (relative: number, depth: number): string | undefined => {
          if (depth > 2) return;
          const start = base + relative,
            count = u16(start);
          if (count > 512) return;
          for (let i = 0; i < count; i++) {
            const p = start + 2 + i * 12,
              tag = u16(p);
            if (tag === 0x8769) {
              const found = parse(u32(p + 8), depth + 1);
              if (found) return found;
            }
            if (tag === 0x9003 || tag === 0x132) {
              const size = u32(p + 4),
                at = size <= 4 ? p + 8 : base + u32(p + 8);
              if (size < 19 || size > 64 || at + size > end) continue;
              const raw = new TextDecoder().decode(bytes.subarray(at, at + 19));
              if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) continue;
              const date = new Date(
                raw.slice(0, 10).replaceAll(":", "-") + "T" + raw.slice(11),
              );
              if (Number.isFinite(date.getTime())) return date.toISOString();
            }
          }
        };
        return parse(u32(base + 4), 0);
      }
      offset += length + 2;
    }
  } catch {}
  return;
}
