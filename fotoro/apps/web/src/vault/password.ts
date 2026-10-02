import { b64, unb64 } from "@fotoro/crypto";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid = () => new Error("INVALID_FOTORO_PASSWORD");

export function formatFotoroPassword(accountId: string, secret: Uint8Array) {
  if (!uuidPattern.test(accountId) || secret.length !== 32) throw invalid();
  const bytes = new Uint8Array(48);
  const hex = accountId.replaceAll("-", "");
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  bytes.set(secret, 16);
  try {
    return "foto_" + b64(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function parseFotoroPassword(value: string) {
  const code = value.trim();
  if (code.startsWith("foto_")) {
    if (!/^foto_[A-Za-z0-9_-]{64}$/.test(code)) throw invalid();
    const bytes = unb64(code.slice(5));
    try {
      if (bytes.length !== 48) throw invalid();
      const hex = [...bytes.subarray(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const accountId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
      return { accountId, secret: bytes.slice(16) };
    } finally {
      bytes.fill(0);
    }
  }
  const parts = code.split(".");
  if (parts.length !== 3 || parts[0] !== "fotoro1" || !uuidPattern.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw invalid();
  try {
    const secret = unb64(parts[2]);
    if (secret.length !== 32) { secret.fill(0); throw invalid(); }
    return { accountId: parts[1].toLowerCase(), secret };
  } catch {
    throw invalid();
  }
}
