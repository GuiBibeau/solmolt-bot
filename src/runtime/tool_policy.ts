import type { ToolPolicy } from "./types.js";

function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }
  return pattern === name;
}

export function isToolAllowed(
  policy: ToolPolicy | undefined,
  name: string,
): boolean {
  if (!policy) return true;
  const allow = policy.allow;
  const deny = policy.deny;
  let allowed = policy.allowAll ?? (!allow || allow.length === 0);
  if (allow && allow.length > 0) {
    allowed = allow.some((pattern) => matchesPattern(pattern, name));
  }
  if (!allowed) return false;
  if (deny?.some((pattern) => matchesPattern(pattern, name))) {
    return false;
  }
  return true;
}

export function mergeToolPolicies(
  base: ToolPolicy | undefined,
  override: ToolPolicy | undefined,
): ToolPolicy | undefined {
  if (!base && !override) return undefined;
  return {
    allowAll: override?.allowAll ?? base?.allowAll,
    allow: [...(base?.allow ?? []), ...(override?.allow ?? [])],
    deny: [...(base?.deny ?? []), ...(override?.deny ?? [])],
  };
}
