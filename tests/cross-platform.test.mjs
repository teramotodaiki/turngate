import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  claim,
  claimResources,
  commandVersion,
  createEmptyState,
  doctor,
  getClaimant,
  getRepositoryPaths,
  handleHookEvent,
  isClaudeInterruptEvent,
  lifecycleFile,
  loadState,
  mergeHookConfig,
  normalizeResourceNames,
  normalizeState,
  ownerIsActiveFromLifecycle,
  repositoryId,
  sameOwner,
  setupHooks,
  status,
  versionAtLeast,
  withDirectoryLock,
  writeLifecycle,
} from "../src/core.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

function temporaryDirectory(prefix = "codex-concurrency-test-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test.afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

function owner(overrides = {}) {
  return {
    provider: "codex",
    sessionId: "session-a",
    turnId: "turn-a",
    transcriptPath: "",
    processFingerprint: null,
    cwd: "/repo",
    branch: "main",
    label: "",
    claimedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function paths() {
  return getRepositoryPaths(join(temporaryDirectory(), ".git"), temporaryDirectory("codex-concurrency-runtime-"));
}

test("state normalization keeps only v2 owners", () => {
  assert.deepEqual(normalizeState(null), createEmptyState());
  assert.deepEqual(normalizeState({ version: 1, gates: { x: owner() } }), createEmptyState());
  const state = normalizeState({ version: 2, updatedAt: null, gates: { x: owner(), broken: {} } });
  assert.deepEqual(Object.keys(state.gates), ["x"]);
});

test("resource normalization removes blanks and duplicates", () => {
  assert.deepEqual(normalizeResourceNames([" git:main ", "", "git:main", "deploy:poc"]), ["git:main", "deploy:poc"]);
});

test("owner identity includes provider, session, and turn", () => {
  assert.equal(sameOwner(owner(), owner()), true);
  assert.equal(sameOwner(owner(), owner({ provider: "claude" })), false);
  assert.equal(sameOwner(owner(), owner({ turnId: "turn-b" })), false);
});

test("multi-resource claims are atomic and same-turn claims expand", () => {
  const first = claimResources(createEmptyState(), ["git:main"], owner(), () => true);
  assert.equal(first.status, "claimed");
  const expanded = claimResources(first.state, ["git:main", "deploy:poc"], owner(), () => true);
  assert.equal(expanded.status, "expanded");
  const blocked = claimResources(expanded.state, ["deploy:poc", "db:primary"], owner({ sessionId: "session-b", turnId: "turn-b" }), () => true);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.state.gates["db:primary"], undefined);
});

test("inactive owners are reclaimed without a lease", () => {
  const first = claimResources(createEmptyState(), ["deploy:poc"], owner(), () => true);
  const second = claimResources(first.state, ["deploy:poc"], owner({ sessionId: "session-b", turnId: "turn-b" }), () => false);
  assert.equal(second.status, "reclaimed");
});

test("repository ids and runtime paths are deterministic across worktrees", () => {
  const common = join(temporaryDirectory(), ".git");
  assert.equal(repositoryId(common), repositoryId(common));
  const first = getRepositoryPaths(common, "C:/runtime");
  const second = getRepositoryPaths(common, "C:/runtime");
  assert.equal(first.stateFile, second.stateFile);
  assert.match(first.stateFile, /repositories/);
});

test("directory lock serializes concurrent writers", async () => {
  const root = temporaryDirectory();
  const lock = join(root, "state.lock");
  let active = 0;
  let maximum = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      withDirectoryLock(lock, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ),
  );
  assert.equal(maximum, 1);
});

test("directory lock serializes independent Node processes", async () => {
  const root = temporaryDirectory();
  const lock = join(root, "state.lock");
  const counter = join(root, "counter.txt");
  writeFileSync(counter, "0");
  const worker = fileURLToPath(new URL("./lock-worker.mjs", import.meta.url));
  await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, [worker, lock, counter])));
  assert.equal(readFileSync(counter, "utf8"), "8");
});

test("Claude interruption markers end only the matching main turn", () => {
  const interrupted = { type: "user", isSidechain: false, message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } };
  assert.equal(isClaudeInterruptEvent(interrupted), true);
  assert.equal(isClaudeInterruptEvent({ ...interrupted, isSidechain: true }), false);
  const lifecycle = { provider: "claude", sessionId: "s", turnId: "t", status: "active" };
  assert.equal(ownerIsActiveFromLifecycle(owner({ provider: "claude", sessionId: "s", turnId: "t" }), lifecycle, [interrupted]), false);
});

test("a later lifecycle turn supersedes an older gate owner", () => {
  const lifecycle = { provider: "claude", sessionId: "s", turnId: "new", status: "active" };
  assert.equal(ownerIsActiveFromLifecycle(owner({ provider: "claude", sessionId: "s", turnId: "old" }), lifecycle), false);
});

test("Claude host process death is used only for trusted fingerprints", () => {
  const lifecycle = { provider: "claude", sessionId: "s", turnId: "t", status: "active" };
  const base = owner({ provider: "claude", sessionId: "s", turnId: "t" });
  assert.equal(ownerIsActiveFromLifecycle({ ...base, processFingerprint: { trustedHost: true, hostname: "missing", pid: 2_147_483_647 } }, lifecycle), false);
  assert.equal(ownerIsActiveFromLifecycle({ ...base, processFingerprint: { trustedHost: false, hostname: "missing", pid: 2_147_483_647 } }, lifecycle), true);
});

test("Claude Stop retains gates while background work or crons remain", async () => {
  const repoPaths = paths();
  const base = { paths: repoPaths, gitCommonDir: "C:/fake/.git", cwd: "C:/fake" };
  await handleHookEvent("claude", { hook_event_name: "SessionStart", session_id: "s", transcript_path: "", cwd: "C:/fake" }, base);
  const started = await handleHookEvent("claude", { hook_event_name: "UserPromptSubmit", session_id: "s", transcript_path: "", cwd: "C:/fake", prompt_id: "turn-1" }, base);
  const claimant = getClaimant(repoPaths, "test", { CODEX_CONCURRENCY_PROVIDER: "claude", CODEX_CONCURRENCY_SESSION_ID: "s" }, "C:/fake");
  await claim(repoPaths, ["deploy:poc"], claimant);
  const retained = await handleHookEvent(
    "claude",
    { hook_event_name: "Stop", session_id: "s", cwd: "C:/fake", background_tasks: [{ id: "task" }], session_crons: [] },
    base,
  );
  assert.equal(started.turnId, "turn-1");
  assert.equal(retained.status, "retained");
  assert.ok((await status(repoPaths)).gates["deploy:poc"]);
});

test("Claude quiescent Stop releases every gate owned by the turn", async () => {
  const repoPaths = paths();
  const base = { paths: repoPaths, gitCommonDir: "C:/fake/.git", cwd: "C:/fake" };
  await handleHookEvent("claude", { hook_event_name: "SessionStart", session_id: "s", transcript_path: "", cwd: "C:/fake" }, base);
  await handleHookEvent("claude", { hook_event_name: "UserPromptSubmit", session_id: "s", transcript_path: "", cwd: "C:/fake", prompt_id: "turn-1" }, base);
  const claimant = getClaimant(repoPaths, "test", { CODEX_CONCURRENCY_PROVIDER: "claude", CODEX_CONCURRENCY_SESSION_ID: "s" }, "C:/fake");
  await claim(repoPaths, ["deploy:poc", "git:main"], claimant);
  const released = await handleHookEvent(
    "claude",
    { hook_event_name: "Stop", session_id: "s", cwd: "C:/fake", background_tasks: [], session_crons: [] },
    base,
  );
  assert.equal(released.status, "released");
  assert.deepEqual((await status(repoPaths)).gates, {});
});

test("Codex Stop releases the exact turn", async () => {
  const repoPaths = paths();
  const base = { paths: repoPaths, gitCommonDir: "C:/fake/.git", cwd: "C:/fake" };
  await handleHookEvent("codex", { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "turn-1", transcript_path: "", cwd: "C:/fake" }, base);
  const claimant = getClaimant(repoPaths, "test", { CODEX_THREAD_ID: "s" }, "C:/fake");
  await claim(repoPaths, ["git:main"], claimant);
  await handleHookEvent("codex", { hook_event_name: "Stop", session_id: "s", turn_id: "turn-1", cwd: "C:/fake" }, base);
  assert.deepEqual((await status(repoPaths)).gates, {});
});

test("setup merges existing hooks, is idempotent, and dry-run does not write", () => {
  const home = temporaryDirectory();
  const codexFile = join(home, ".codex", "hooks.json");
  const first = setupHooks({ host: "codex", home, executablePath: "C:/tool/cli.mjs" });
  assert.equal(first[0].changed, true);
  const config = JSON.parse(readFileSync(codexFile, "utf8"));
  config.hooks.Stop.unshift({ hooks: [{ type: "command", command: "existing-hook" }] });
  writeFileSync(codexFile, JSON.stringify(config));
  const second = setupHooks({ host: "codex", home, executablePath: "C:/tool/cli.mjs" });
  assert.equal(second[0].changed, false);
  const preserved = JSON.parse(readFileSync(codexFile, "utf8"));
  assert.ok(preserved.hooks.Stop.some((group) => group.hooks?.some((hook) => hook.command === "existing-hook")));
  const before = readFileSync(codexFile, "utf8");
  const dryRun = setupHooks({ host: "codex", home, executablePath: "D:/new/cli.mjs", dryRun: true });
  assert.equal(dryRun[0].changed, true);
  assert.equal(readFileSync(codexFile, "utf8"), before);
});

test("setup fails closed instead of replacing malformed settings", () => {
  const home = temporaryDirectory();
  const directory = join(home, ".claude");
  const file = join(directory, "settings.json");
  setupHooks({ host: "claude", home, executablePath: "C:/tool/cli.mjs" });
  writeFileSync(file, "{ malformed");
  assert.throws(() => setupHooks({ host: "claude", home, executablePath: "C:/tool/cli.mjs" }), /malformed claude settings/);
  assert.equal(readFileSync(file, "utf8"), "{ malformed");
});

test("mergeHookConfig uses only documented hook fields", () => {
  const result = mergeHookConfig({}, "claude", "C:/tool/cli.mjs");
  for (const groups of Object.values(result.hooks)) {
    for (const group of groups) assert.deepEqual(Object.keys(group), ["hooks"]);
  }
});

test("version checks reject Claude Code releases without complete-quiescence fields", () => {
  assert.equal(versionAtLeast("2.1.144 (Claude Code)", "2.1.145"), false);
  assert.equal(versionAtLeast("2.1.145 (Claude Code)", "2.1.145"), true);
  assert.equal(versionAtLeast("2.2.0 (Claude Code)", "2.1.145"), true);
});

test("version checks resolve Windows command shims through cmd.exe", () => {
  let invocation;
  const version = commandVersion("codex", {
    systemPlatform: "win32",
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "codex-cli 0.144.1\n", stderr: "" };
    },
  });
  assert.equal(version, "codex-cli 0.144.1");
  assert.equal(invocation.args.at(-1), "codex --version");
  assert.equal(invocation.options.shell, undefined);
});

test("doctor reports missing hooks, trust state, and a writable runtime", () => {
  const home = temporaryDirectory();
  const runtime = temporaryDirectory("codex-concurrency-doctor-");
  const result = doctor({ cwd: process.cwd(), home, env: { ...process.env, CODEX_CONCURRENCY_HOME: runtime, CODEX_THREAD_ID: "" } });
  assert.equal(result.checks.find((check) => check.name === "codex-hooks").ok, false);
  assert.equal(result.checks.find((check) => check.name === "claude-hooks").ok, false);
  assert.equal(result.checks.find((check) => check.name === "runtime-state").ok, true);
  assert.match(result.checks.find((check) => check.name === "codex-hook-trust").detail, /unverified/);
});

test("lifecycle file names do not expose provider session ids", () => {
  const repoPaths = paths();
  const file = lifecycleFile(repoPaths, "claude", "secret-looking-session-id");
  assert.doesNotMatch(file, /secret-looking-session-id/);
  writeLifecycle(repoPaths, { provider: "claude", sessionId: "s", turnId: "t", status: "active" });
  assert.equal(loadState(repoPaths.stateFile).version, 2);
});
