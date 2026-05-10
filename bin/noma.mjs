#!/usr/bin/env node
// Production CLI entry — loads the compiled dist build.
// During development use `npm run noma -- ...` (which goes through tsx).
import("../dist/cli.js").catch((err) => {
  console.error("noma: failed to load CLI. Did you run `npm run build`?");
  console.error(err);
  process.exit(1);
});
