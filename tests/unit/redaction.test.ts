import { expect, test } from "bun:test";
import { redact } from "../../src/util/redaction.js";

// Redaction should only mask secret-like keys.
test("redact masks secret keys but leaves normal fields", () => {
  const input = {
    apiKey: "secret-value",
    token: "another-secret",
    privateKey: "pk",
    keep: "hello",
    nested: {
      authorization: "bearer xxx",
      normal: "ok",
    },
    list: [{ secret: "nope" }, { foo: "bar" }],
  };

  const out = redact(input);
  expect(out.apiKey).toBe("***");
  expect(out.token).toBe("***");
  expect(out.privateKey).toBe("***");
  expect(out.keep).toBe("hello");
  const typed = out as {
    nested: { authorization: string; normal: string };
    list: Array<{ secret?: string; foo?: string }>;
  };
  expect(typed.nested.authorization).toBe("***");
  expect(typed.nested.normal).toBe("ok");
  expect(typed.list[0]?.secret).toBe("***");
  expect(typed.list[1]?.foo).toBe("bar");
});
