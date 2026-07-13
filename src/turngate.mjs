#!/usr/bin/env node

// Public module entry point.
export * from "./core.mjs";
export { runCli } from "./cli.mjs";

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.mjs";

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  }
})();

if (isMain) {
  runCli().catch((error) => {
    console.error(`[turngate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
