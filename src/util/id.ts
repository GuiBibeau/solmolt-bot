import crypto from "node:crypto";

export function randomId(prefix = "id"): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}
