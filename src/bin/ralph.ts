#!/usr/bin/env node
import "../util/suppress_bigint_warning.js";
await import("./ralph_main.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
