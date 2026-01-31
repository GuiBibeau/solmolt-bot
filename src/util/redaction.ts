const SECRET_KEY_PATTERN =
  /(privateKey|secret|apiKey|token|authorization|auth|bearer)/i;
const BYTE_LIKE = /(Uint8Array|Buffer)/;

export type Redactable = unknown;

function shouldRedactKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redact(value: Redactable, depth = 0): Redactable {
  if (depth > 8) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (shouldRedactKey(key)) {
      out[key] = "***";
      continue;
    }
    if (val && typeof val === "object") {
      const tag = Object.prototype.toString.call(val);
      if (BYTE_LIKE.test(tag)) {
        out[key] = "<redacted-bytes>";
        continue;
      }
    }
    out[key] = redact(val, depth + 1);
  }
  return out;
}
