#!/usr/bin/env node
// Run the single-file debug playwright test for a given corpus file.
// Usage: npm run test:debug -- fuzz-12345.json

import { spawnSync } from "node:child_process";

const fileArg = process.argv[2];
if (!fileArg) {
  console.error("Usage: npm run test:debug -- <corpus-file.json>");
  process.exit(1);
}

const env = { ...process.env, FUZZ_FILE: fileArg };
const result = spawnSync(
  "npx",
  ["playwright", "test", "--project", "debug", "--reporter=line"],
  { env, stdio: "inherit", shell: true },
);
process.exit(result.status ?? 1);
