#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const STATE_VERSION = 1;
const LOCK_HELD_ENV = "CONCURRENCY_GATE_LOCK_HELD";
const CLAIM_ATTEMPT_ENV = "CONCURRENCY_GATE_CLAIM_ATTEMPT";
const BLOCKED_EXIT_CODE = 75;
const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const WAIT_NOTICE_INTERVAL_MS = 30 * 1000;

export function createEmptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: null,
    gates: {},
  };
}

export function normalizeState(value) {
  if (!value || typeof value !== "object") {
    return createEmptyState();
  }

  const gates =
    value.gates && typeof value.gates === "object" && !Array.isArray(value.gates)
      ? Object.fromEntries(
          Object.entries(value.gates)
            .filter(([name, owner]) => typeof name === "string" && name.length > 0 && owner && typeof owner === "object")
            .map(([name, owner]) => [name, owner]),
        )
      : {};

  return {
    version: STATE_VERSION,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    gates,
  };
}

function getTurnStartIdFromEvent(event) {
  if (!event || typeof event !== "object") {
    return "";
  }

  if (event.type === "turn_context" && typeof event.payload?.turn_id === "string") {
    return event.payload.turn_id;
  }

  if (event.type === "event_msg" && event.payload?.type === "task_started" && typeof event.payload?.turn_id === "string") {
    return event.payload.turn_id;
  }

  return "";
}

export function getLatestTurnIdFromEvents(events) {
  let latestTurnId = "";
  for (const event of events) {
    const turnId = getTurnStartIdFromEvent(event);
    if (turnId.length > 0) {
      latestTurnId = turnId;
    }
  }
  return latestTurnId;
}

export function getCurrentTurnIdFromEvents(events) {
  const latestTurnId = getLatestTurnIdFromEvents(events);
  return isTurnActiveFromEvents(events, latestTurnId) ? latestTurnId : "";
}

export function hasTaskCompleteForTurn(events, turnId) {
  if (typeof turnId !== "string" || turnId.length === 0) {
    return false;
  }

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type !== "event_msg") continue;
    if (event.payload?.type !== "task_complete") continue;
    if (event.payload?.turn_id === turnId) {
      return true;
    }
  }

  return false;
}

export function isTurnActiveFromEvents(events, turnId) {
  if (typeof turnId !== "string" || turnId.length === 0) {
    return false;
  }

  let sawTurn = false;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;

    if (event.type === "event_msg" && event.payload?.type === "task_complete" && event.payload?.turn_id === turnId) {
      return false;
    }

    const eventTurnId = getTurnStartIdFromEvent(event);
    if (eventTurnId.length === 0) continue;

    if (eventTurnId === turnId) {
      sawTurn = true;
      continue;
    }

    if (sawTurn) {
      return false;
    }
  }

  return sawTurn;
}

export function pruneInactiveGateRecords(state, isOwnerActive) {
  const nextState = normalizeState(state);
  let changed = false;

  for (const [gateName, owner] of Object.entries(nextState.gates)) {
    if (!isOwnerActive(owner)) {
      delete nextState.gates[gateName];
      changed = true;
    }
  }

  if (changed) {
    nextState.updatedAt = new Date().toISOString();
  }

  return {
    state: nextState,
    changed,
  };
}

function sameOwner(left, right) {
  return left?.threadId === right?.threadId && left?.turnId === right?.turnId;
}

export function normalizeResourceNames(resourceNames) {
  if (!Array.isArray(resourceNames)) {
    return [];
  }

  return [...new Set(resourceNames.filter((name) => typeof name === "string").map((name) => name.trim()).filter(Boolean))];
}

export function claimResources(state, resourceNames, claimant, isOwnerActive) {
  const nextState = normalizeState(state);
  const normalizedResources = normalizeResourceNames(resourceNames);
  const blocked = [];
  let sawActiveSameOwner = false;
  let sawInactiveOwner = false;
  let sawNewResource = false;

  for (const resourceName of normalizedResources) {
    const existingOwner = nextState.gates[resourceName];
    if (!existingOwner) {
      sawNewResource = true;
      continue;
    }

    if (isOwnerActive(existingOwner)) {
      if (sameOwner(existingOwner, claimant)) {
        sawActiveSameOwner = true;
        continue;
      }

      blocked.push({ resource: resourceName, owner: existingOwner });
      continue;
    }

    sawInactiveOwner = true;
  }

  if (blocked.length > 0) {
    return {
      status: "blocked",
      state: nextState,
      blocked,
    };
  }

  for (const resourceName of normalizedResources) {
    nextState.gates[resourceName] = claimant;
  }

  nextState.updatedAt = new Date().toISOString();

  let status = "claimed";
  if (!sawNewResource && !sawInactiveOwner && sawActiveSameOwner) {
    status = "already-owner";
  } else if (sawInactiveOwner) {
    status = "reclaimed";
  } else if (sawActiveSameOwner) {
    status = "expanded";
  }

  return {
    status,
    state: nextState,
    owner: claimant,
    resources: normalizedResources,
  };
}

function fail(message, details = []) {
  console.error(`[codex-concurrency] ${message}`);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
  process.exit(1);
}

export function parseDurationMs(raw, optionName = "duration") {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${optionName} の値が必要です。`);
  }

  const match = raw.trim().toLowerCase().match(/^(\d+)(ms|s|m)$/);
  if (!match) {
    throw new Error(`${optionName} は 500ms, 5s, 10m のように指定してください。 value: ${raw}`);
  }

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`${optionName} の値が大きすぎます。 value: ${raw}`);
  }

  const unit = match[2];
  const multiplier = unit === "m" ? 60 * 1000 : unit === "s" ? 1000 : 1;
  const durationMs = amount * multiplier;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error(`${optionName} は 0 より大きい値を指定してください。 value: ${raw}`);
  }

  return durationMs;
}

function parseDurationArg(raw, optionName) {
  try {
    return parseDurationMs(raw, optionName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
}

function formatDurationMs(durationMs) {
  const boundedMs = Math.max(0, Math.ceil(durationMs));
  const minutes = Math.floor(boundedMs / 60000);
  const seconds = Math.ceil((boundedMs % 60000) / 1000);
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command) {
    fail("command が必要です。", ["Usage: codex-concurrency claim <resource>... [--label <text>] [--no-wait]"]);
  }

  if (command === "--help" || command === "help") {
    return { command: "help" };
  }

  if (command !== "claim" && command !== "status") {
    fail(`未知の command です: ${command}`);
  }

  const resourceNames = [];
  while (args[0] && !args[0].startsWith("--")) {
    resourceNames.push(args.shift() ?? "");
  }

  if (command === "claim" && resourceNames.length === 0) {
    fail("claim には resource 名が必要です。");
  }

  let label = "";
  let json = false;
  let wait = command === "claim";
  let timeoutMs = DEFAULT_CLAIM_TIMEOUT_MS;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--label") {
      label = args.shift() ?? "";
      if (label.length === 0) {
        fail("--label の値が必要です。");
      }
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--wait") {
      if (command !== "claim") {
        fail("--wait は claim でのみ使用できます。");
      }
      wait = true;
      continue;
    }
    if (arg === "--no-wait") {
      if (command !== "claim") {
        fail("--no-wait は claim でのみ使用できます。");
      }
      wait = false;
      continue;
    }
    if (arg === "--timeout") {
      if (command !== "claim") {
        fail("--timeout は claim でのみ使用できます。");
      }
      timeoutMs = parseDurationArg(args.shift() ?? "", "--timeout");
      if (timeoutMs > MAX_CLAIM_TIMEOUT_MS) {
        fail("--timeout は最大 10m までです。", [`value: ${formatDurationMs(timeoutMs)}`]);
      }
      wait = true;
      continue;
    }
    if (arg === "--poll-interval") {
      if (command !== "claim") {
        fail("--poll-interval は claim でのみ使用できます。");
      }
      pollIntervalMs = parseDurationArg(args.shift() ?? "", "--poll-interval");
      continue;
    }
    fail(`未知の引数です: ${arg}`);
  }

  return {
    command,
    resourceNames: normalizeResourceNames(resourceNames),
    label,
    json,
    wait,
    timeoutMs,
    pollIntervalMs,
  };
}

function getCodexHome() {
  return resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
}

function getGitCommonDir(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    fail("git common dir を取得できませんでした。", [stderr || "git rev-parse --git-common-dir failed"]);
  }

  const raw = (result.stdout ?? "").trim();
  if (raw.length === 0) {
    fail("git common dir の出力が空です。");
  }

  return resolve(cwd, raw);
}

export function getStatePaths(gitCommonDir) {
  const gateDir = join(resolve(gitCommonDir), "codex-concurrency");
  return {
    gateDir,
    stateFile: join(gateDir, "state.json"),
    lockFile: join(gateDir, "state.lock"),
  };
}

function getCurrentBranch(cwd = process.cwd()) {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

function findSessionFiles(rootDir, threadId) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const matches = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(`${threadId}.jsonl`) && !entry.name.endsWith(`${threadId}.json`)) {
        continue;
      }
      matches.push(nextPath);
    }
  }

  return matches.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function findLatestSessionFile(threadId, codexHome = getCodexHome()) {
  const activeMatches = findSessionFiles(join(codexHome, "sessions"), threadId);
  if (activeMatches.length > 0) {
    return activeMatches[0];
  }

  const archivedMatches = findSessionFiles(join(codexHome, "archived_sessions"), threadId);
  return archivedMatches[0] ?? null;
}

async function readSessionEvents(sessionFile) {
  const events = [];
  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Codex app can be appending the last line while we read. Ignore the partial line.
    }
  }

  return events;
}

async function readSessionSnapshot(sessionFile) {
  const events = await readSessionEvents(sessionFile);
  return {
    sessionFile,
    currentTurnId: getCurrentTurnIdFromEvents(events),
    latestTurnId: getLatestTurnIdFromEvents(events),
    events,
  };
}

function readThreadName(threadId, codexHome = getCodexHome()) {
  const indexPath = join(codexHome, "session_index.jsonl");
  if (!existsSync(indexPath)) {
    return "";
  }

  let latestName = "";
  const lines = readFileSync(indexPath, "utf8").split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.id === threadId && typeof row.thread_name === "string") {
      latestName = row.thread_name;
    }
  }

  return latestName;
}

function loadState(stateFile) {
  if (!existsSync(stateFile)) {
    return createEmptyState();
  }

  const raw = readFileSync(stateFile, "utf8");
  return normalizeState(JSON.parse(raw));
}

function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempFile, stateFile);
}

async function isOwnerActive(owner) {
  const sessionFile = typeof owner?.sessionFile === "string" && owner.sessionFile.length > 0 ? owner.sessionFile : "";
  const threadId = typeof owner?.threadId === "string" ? owner.threadId : "";
  const turnId = typeof owner?.turnId === "string" ? owner.turnId : "";
  if (threadId.length === 0 || turnId.length === 0) {
    return false;
  }

  const candidateFile = sessionFile || findLatestSessionFile(threadId);
  if (!candidateFile || !existsSync(candidateFile)) {
    return false;
  }

  const snapshot = await readSessionSnapshot(candidateFile);
  return isTurnActiveFromEvents(snapshot.events, turnId);
}

async function pruneState(state) {
  const nextState = normalizeState(state);
  let changed = false;

  for (const [gateName, owner] of Object.entries(nextState.gates)) {
    if (!(await isOwnerActive(owner))) {
      delete nextState.gates[gateName];
      changed = true;
    }
  }

  if (changed) {
    nextState.updatedAt = new Date().toISOString();
  }

  return {
    state: nextState,
    changed,
  };
}

async function getClaimant(label) {
  const threadId = (process.env.CODEX_THREAD_ID ?? "").trim();
  if (threadId.length === 0) {
    fail("CODEX_THREAD_ID が無いセッションでは task gate を claim できません。");
  }

  const sessionFile = findLatestSessionFile(threadId);
  if (!sessionFile) {
    fail("現在の Codex session file を特定できませんでした。", [`threadId: ${threadId}`]);
  }

  const snapshot = await readSessionSnapshot(sessionFile);
  if (snapshot.currentTurnId.length === 0) {
    fail("現在 turn の turn_id を特定できませんでした。", [sessionFile]);
  }

  return {
    threadId,
    threadName: readThreadName(threadId),
    turnId: snapshot.currentTurnId,
    sessionFile,
    cwd: process.cwd(),
    branch: getCurrentBranch(),
    label,
    claimedAt: new Date().toISOString(),
  };
}

function formatOwner(owner) {
  const details = [];
  if (owner.threadName) details.push(`thread_name: ${owner.threadName}`);
  details.push(`thread_id: ${owner.threadId}`);
  details.push(`turn_id: ${owner.turnId}`);
  if (owner.branch) details.push(`branch: ${owner.branch}`);
  if (owner.label) details.push(`label: ${owner.label}`);
  details.push(`claimed_at: ${owner.claimedAt}`);
  if (owner.cwd) details.push(`cwd: ${owner.cwd}`);
  if (owner.sessionFile) details.push(`session_file: ${owner.sessionFile}`);
  return details;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  codex-concurrency claim <resource>... [--label <text>] [--json] [--wait|--no-wait] [--timeout <duration>] [--poll-interval <duration>]",
      "  codex-concurrency status [<resource>...] [--json]",
      "",
      "Gate ownership is stored in $(git rev-parse --git-common-dir)/codex-concurrency/state.json.",
      "A gate stays active while the owning turn is the current active turn in its Codex session log.",
      "",
    ].join("\n"),
  );
}

async function attemptClaim({ resourceNames, label, stateFile }) {
  const claimant = await getClaimant(label);
  const loadedState = loadState(stateFile);
  const { state: prunedState, changed } = await pruneState(loadedState);
  const result = claimResources(prunedState, resourceNames, claimant, () => true);

  if (result.status === "blocked") {
    if (changed) {
      saveState(stateFile, prunedState);
    }

    return {
      status: "blocked",
      resources: resourceNames,
      blocked: result.blocked,
    };
  }

  saveState(stateFile, result.state);

  return {
    status: result.status,
    resources: result.resources,
    owner: result.owner,
  };
}

function printBlockedClaimResult(result) {
  console.error("[codex-concurrency] requested resources are already in use by other turns.");
  for (const blocked of result.blocked) {
    console.error(`- resource: ${blocked.resource}`);
    for (const detail of formatOwner(blocked.owner)) {
      console.error(`  ${detail}`);
    }
  }
}

function printClaimResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log(`[codex-concurrency] ${result.status}: ${result.resources.join(", ")}`);
  for (const detail of formatOwner(result.owner)) {
    console.log(`- ${detail}`);
  }
}

async function handleClaim({ resourceNames, label, json, stateFile }) {
  const result = await attemptClaim({ resourceNames, label, stateFile });

  if (result.status === "blocked") {
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printBlockedClaimResult(result);
    }
    process.exit(1);
  }

  printClaimResult(result, json);
}

function runLockedClaimAttempt(lockFile, argv, timeoutMs) {
  mkdirSync(dirname(lockFile), { recursive: true });
  const result = spawnSync(
    "lockf",
    ["-k", lockFile, process.execPath, fileURLToPath(import.meta.url), ...argv],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: Math.max(1, timeoutMs),
      env: {
        ...process.env,
        [LOCK_HELD_ENV]: "1",
        [CLAIM_ATTEMPT_ENV]: "1",
      },
    },
  );

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      return { status: "attempt-timeout" };
    }
    fail("lockf の起動に失敗しました。", [result.error.message]);
  }

  const stdout = (result.stdout ?? "").trim();
  if (result.status !== 0 && result.status !== BLOCKED_EXIT_CODE) {
    const details = [];
    const stderr = (result.stderr ?? "").trim();
    if (stderr.length > 0) details.push(stderr);
    if (stdout.length > 0) details.push(stdout);
    fail("claim attempt に失敗しました。", details);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    fail("claim attempt の結果を解釈できませんでした。", [stdout || "(empty stdout)"]);
  }
}

function getPollDelayMs(pollIntervalMs, remainingMs) {
  const jitterMs = Math.floor(Math.random() * Math.min(250, Math.max(1, Math.floor(pollIntervalMs * 0.2))));
  return Math.min(remainingMs, pollIntervalMs + jitterMs);
}

function printWaitingForClaim(result, remainingMs, isFirstNotice) {
  const prefix = isFirstNotice
    ? "gate is busy; waiting for release and retrying automatically"
    : "still waiting for gate release and retrying automatically";
  console.error(`[codex-concurrency] ${prefix}; timeout in ${formatDurationMs(remainingMs)}.`);
  for (const blocked of result.blocked) {
    console.error(`- resource: ${blocked.resource}`);
    for (const detail of formatOwner(blocked.owner)) {
      console.error(`  ${detail}`);
    }
  }
}

function printClaimTimeout(result, resourceNames, timeoutMs, json) {
  const payload = {
    status: "timeout",
    resources: resourceNames,
    timeoutMs,
    blocked: result?.blocked ?? [],
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.error(`[codex-concurrency] timed out after ${formatDurationMs(timeoutMs)} waiting for requested resources.`);
  if (result?.blocked) {
    printBlockedClaimResult(result);
  }
}

async function handleClaimWithWait({ resourceNames, json, timeoutMs, pollIntervalMs, lockFile, argv }) {
  const deadlineMs = Date.now() + timeoutMs;
  let lastBlockedResult = null;
  let nextNoticeAtMs = 0;
  let printedWaitingNotice = false;

  while (true) {
    const remainingBeforeAttemptMs = deadlineMs - Date.now();
    if (remainingBeforeAttemptMs <= 0) {
      printClaimTimeout(lastBlockedResult, resourceNames, timeoutMs, json);
      process.exit(1);
    }

    const result = runLockedClaimAttempt(lockFile, argv, remainingBeforeAttemptMs);
    if (result.status === "attempt-timeout") {
      printClaimTimeout(lastBlockedResult, resourceNames, timeoutMs, json);
      process.exit(1);
    }

    if (result.status !== "blocked") {
      printClaimResult(result, json);
      return;
    }

    lastBlockedResult = result;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      printClaimTimeout(lastBlockedResult, resourceNames, timeoutMs, json);
      process.exit(1);
    }

    const nowMs = Date.now();
    if (nowMs >= nextNoticeAtMs) {
      printWaitingForClaim(result, remainingMs, !printedWaitingNotice);
      printedWaitingNotice = true;
      nextNoticeAtMs = nowMs + WAIT_NOTICE_INTERVAL_MS;
    }

    await sleep(getPollDelayMs(pollIntervalMs, remainingMs));
  }
}

async function handleStatus({ resourceNames, json, stateFile }) {
  const loadedState = loadState(stateFile);
  const { state: prunedState, changed } = await pruneState(loadedState);
  if (changed) {
    saveState(stateFile, prunedState);
  }

  const activeGates =
    resourceNames.length > 0
      ? Object.fromEntries(resourceNames.map((resourceName) => [resourceName, prunedState.gates[resourceName] ?? null]))
      : prunedState.gates;

  if (json) {
    process.stdout.write(`${JSON.stringify({ gates: activeGates }, null, 2)}\n`);
    return;
  }

  if (resourceNames.length > 0) {
    for (const resourceName of resourceNames) {
      const owner = activeGates[resourceName];
      if (!owner) {
        console.log(`[codex-concurrency] ${resourceName}: available`);
        continue;
      }
      console.log(`[codex-concurrency] ${resourceName}: active`);
      for (const detail of formatOwner(owner)) {
        console.log(`- ${detail}`);
      }
    }
    return;
  }

  const entries = Object.entries(activeGates);
  if (entries.length === 0) {
    console.log("[codex-concurrency] active gates: none");
    return;
  }

  console.log("[codex-concurrency] active gates:");
  for (const [name, owner] of entries) {
    console.log(`- ${name}`);
    for (const detail of formatOwner(owner)) {
      console.log(`  ${detail}`);
    }
  }
}

function ensureLockHeld(lockFile) {
  if (process.env[LOCK_HELD_ENV] === "1") {
    return;
  }

  mkdirSync(dirname(lockFile), { recursive: true });
  const result = spawnSync(
    "lockf",
    ["-k", lockFile, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        [LOCK_HELD_ENV]: "1",
      },
    },
  );

  if (result.error) {
    fail("lockf の起動に失敗しました。", [result.error.message]);
  }

  process.exit(result.status ?? 1);
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === "help") {
    printHelp();
    return;
  }

  const gitCommonDir = getGitCommonDir();
  const { stateFile, lockFile } = getStatePaths(gitCommonDir);

  if (args.command === "claim" && process.env[CLAIM_ATTEMPT_ENV] === "1") {
    ensureLockHeld(lockFile);
    const result = await attemptClaim({ ...args, stateFile });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "blocked" ? BLOCKED_EXIT_CODE : 0;
    return;
  }

  if (args.command === "claim" && args.wait && process.env[LOCK_HELD_ENV] !== "1") {
    await handleClaimWithWait({ ...args, lockFile, argv });
    return;
  }

  ensureLockHeld(lockFile);

  if (args.command === "claim") {
    await handleClaim({ ...args, stateFile });
    return;
  }

  if (args.command === "status") {
    await handleStatus({ ...args, stateFile });
  }
}

const isMainModule = (() => {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isMainModule) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    fail("codex-concurrency の実行に失敗しました。", [message]);
  });
}
