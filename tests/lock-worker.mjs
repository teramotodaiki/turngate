import { readFileSync, writeFileSync } from "node:fs";
import { withDirectoryLock } from "../src/core.mjs";

const [lockDir, counterFile] = process.argv.slice(2);

await withDirectoryLock(lockDir, async () => {
  const current = Number(readFileSync(counterFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 20)));
  writeFileSync(counterFile, String(current + 1));
});
