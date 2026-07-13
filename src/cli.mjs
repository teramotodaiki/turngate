#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CLAIM_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_CLAIM_TIMEOUT_MS,
  claim,
  doctor,
  getClaimant,
  getGitCommonDir,
  getRepositoryPaths,
  handleHookEvent,
  setupHooks,
  status,
} from "./core.mjs";

function fail(message) {
  console.error(`[codex-concurrency] ${message}`);
  process.exitCode = 1;
}

function parseDuration(value, name) {
  const match = /^(\d+)(ms|s|m)$/.exec(value ?? "");
  if (!match) throw new Error(`${name} must look like 500ms, 5s, or 10m`);
  const amount = Number(match[1]);
  const milliseconds = amount * (match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error(`${name} must be greater than zero`);
  return milliseconds;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) positional.push(value);
    else if (["--json", "--no-wait", "--dry-run"].includes(value)) flags[value.slice(2)] = true;
    else flags[value.slice(2)] = rest[++index];
  }
  return { command, positional, flags };
}

function help() {
  console.log(`Usage:
  codex-concurrency claim <resource>... [--label text] [--no-wait] [--timeout 10m] [--poll-interval 5s] [--json]
  codex-concurrency status [resource...] [--json]
  codex-concurrency setup [--host codex|claude|all] [--dry-run] [--json]
  codex-concurrency doctor [--json]

Claims are tied to the active Codex or Claude Code turn and are released automatically.`);
}

async function readStdinJson() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text || "{}");
}

function print(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value)) for (const row of value) console.log(`${row.provider}: ${row.changed ? row.dryRun ? "would update" : "updated" : "already configured"} ${row.file}`);
  else console.log(value);
}

function ownerSummary(owner) {
  return `${owner.provider}:${owner.sessionId}:${owner.turnId}${owner.label ? ` (${owner.label})` : ""}`;
}

async function runClaim(args, paths) {
  if (args.positional.length === 0) throw new Error("claim requires at least one resource");
  const claimant = getClaimant(paths, args.flags.label ?? "");
  const wait = !args.flags["no-wait"];
  const timeout = args.flags.timeout ? parseDuration(args.flags.timeout, "--timeout") : DEFAULT_CLAIM_TIMEOUT_MS;
  const poll = args.flags["poll-interval"] ? parseDuration(args.flags["poll-interval"], "--poll-interval") : DEFAULT_POLL_INTERVAL_MS;
  if (timeout > MAX_CLAIM_TIMEOUT_MS) throw new Error("--timeout cannot exceed 10m");
  const deadline = Date.now() + timeout;
  while (true) {
    const result = await claim(paths, args.positional, claimant);
    if (result.status !== "blocked") {
      if (args.flags.json) print(result, true);
      else console.log(`[codex-concurrency] ${result.status}: ${result.resources.join(", ")} owner=${ownerSummary(result.owner)}`);
      return;
    }
    if (!wait || Date.now() + poll > deadline) {
      if (args.flags.json) print({ ...result, status: wait ? "timeout" : "blocked" }, true);
      else for (const item of result.blocked) console.error(`[codex-concurrency] ${item.resource} held by ${ownerSummary(item.owner)}`);
      process.exitCode = 1;
      return;
    }
    console.error(`[codex-concurrency] busy; retrying in ${poll}ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, poll));
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.command || args.command === "help" || args.command === "--help") return help();
  if (args.command === "setup") {
    const results = setupHooks({ host: args.flags.host ?? "all", dryRun: Boolean(args.flags["dry-run"]), executablePath: fileURLToPath(import.meta.url) });
    print(results, args.flags.json);
    if (!args.flags["dry-run"] && results.some((row) => row.provider === "codex" && row.changed)) console.error("[codex-concurrency] review and trust the new Codex hooks with /hooks before claiming gates.");
    return;
  }
  if (args.command === "doctor") {
    const result = doctor();
    if (args.flags.json) print(result, true);
    else for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args.command === "hook") {
    const provider = args.positional[0];
    const input = await readStdinJson();
    const result = await handleHookEvent(provider, input);
    if (args.flags.json) print(result, true);
    return;
  }
  const common = getGitCommonDir();
  const paths = getRepositoryPaths(common);
  if (args.command === "claim") return runClaim(args, paths);
  if (args.command === "status") {
    const result = await status(paths, args.positional);
    if (args.flags.json) print(result, true);
    else {
      const entries = Object.entries(result.gates);
      if (entries.length === 0) console.log("[codex-concurrency] active gates: none");
      for (const [resource, owner] of entries) console.log(`${resource}: ${owner ? ownerSummary(owner) : "available"}`);
    }
    return;
  }
  throw new Error(`unknown command: ${args.command}`);
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  }
})();

if (isMain) runCli().catch((error) => fail(error instanceof Error ? error.message : String(error)));

