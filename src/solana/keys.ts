import fs from "node:fs";
import bs58 from "bs58";

export function loadSecretKey(value?: string, filePath?: string): Uint8Array {
  if (filePath && fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseSecretKeyString(raw);
  }
  if (!value) {
    throw new Error("Wallet private key is missing.");
  }
  return parseSecretKeyString(value);
}

function parseSecretKeyString(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return Uint8Array.from(parsed.map((value) => Number(value)));
    }
    throw new Error("Invalid wallet key JSON array.");
  }
  if (trimmed.startsWith("base64:")) {
    return Uint8Array.from(Buffer.from(trimmed.slice(7), "base64"));
  }
  if (trimmed.startsWith("hex:")) {
    return Uint8Array.from(Buffer.from(trimmed.slice(4), "hex"));
  }
  return bs58.decode(trimmed);
}
