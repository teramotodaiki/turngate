import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  getGitCommonDir,
  getRepositoryPaths,
  handleHookEvent,
  isClaudeInterruptEvent,
  lifecycleFile,
  loadState,
  mergeHookConfig,
  normalizeResourceNames,
  normalizeState,
  ownerIsActiveFromLifecycle,
  readCodexTurnEvents,
  readHookObservation,
  readLifecycle,
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

function temporaryDirectory(prefix = "turngate-test-") {
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
  return getRepositoryPaths(join(temporaryDirectory(), ".git"), temporaryDirectory("turngate-runtime-"));
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
  const claimant = getClaimant(repoPaths, "test", { TURNGATE_PROVIDER: "claude", TURNGATE_SESSION_ID: "s" }, "C:/fake");
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
  const claimant = getClaimant(repoPaths, "test", { TURNGATE_PROVIDER: "claude", TURNGATE_SESSION_ID: "s" }, "C:/fake");
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

test("Git common dir canonicalizes Windows short path aliases", { skip: process.platform !== "win32" }, async () => {
  const shortRepo = temporaryDirectory("turngate-path-alias-");
  await execFileAsync("git", ["init", "--quiet", shortRepo]);
  const { stdout } = await execFileAsync("git", ["-C", shortRepo, "rev-parse", "--show-toplevel"]);
  const longRepo = stdout.trim();

  assert.equal(getGitCommonDir(shortRepo), getGitCommonDir(longRepo));
  assert.equal(repositoryId(getGitCommonDir(shortRepo)), repositoryId(getGitCommonDir(longRepo)));
});

test("Codex next prompt reactivates a completed session", async () => {
  const repoPaths = paths();
  const base = { paths: repoPaths, gitCommonDir: "C:/fake/.git", cwd: "C:/fake" };
  await handleHookEvent("codex", { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "turn-1", transcript_path: "", cwd: "C:/fake" }, base);
  await handleHookEvent("codex", { hook_event_name: "Stop", session_id: "s", turn_id: "turn-1", cwd: "C:/fake" }, base);
  await handleHookEvent("codex", { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "turn-2", transcript_path: "", cwd: "C:/fake" }, base);

  const lifecycle = readLifecycle(repoPaths, "codex", "s");
  assert.equal(lifecycle.status, "active");
  assert.equal(lifecycle.turnId, "turn-2");
  assert.equal(lifecycle.completedAt, "");
});

test("a stale Codex Stop cannot complete or release the newer turn", async () => {
  const repoPaths = paths();
  const base = { paths: repoPaths, gitCommonDir: "C:/fake/.git", cwd: "C:/fake" };
  await handleHookEvent("codex", { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "turn-1", transcript_path: "", cwd: "C:/fake" }, base);
  await handleHookEvent("codex", { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "turn-2", transcript_path: "", cwd: "C:/fake" }, base);
  const claimant = getClaimant(repoPaths, "new turn", { CODEX_THREAD_ID: "s" }, "C:/fake");
  await claim(repoPaths, ["git:main"], claimant);

  const stale = await handleHookEvent("codex", { hook_event_name: "Stop", session_id: "s", turn_id: "turn-1", cwd: "C:/fake" }, base);

  assert.equal(stale.status, "ignored");
  assert.equal(stale.reason, "stale-turn");
  assert.equal(readLifecycle(repoPaths, "codex", "s").turnId, "turn-2");
  assert.equal(readLifecycle(repoPaths, "codex", "s").status, "active");
  assert.equal((await status(repoPaths)).gates["git:main"].turnId, "turn-2");
});

test("Codex claimant adopts the newer active transcript turn", async () => {
  const repoPaths = paths();
  const transcript = join(temporaryDirectory(), "codex.jsonl");
  writeFileSync(
    transcript,
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
    ].map((event) => JSON.stringify(event)).join("\n"),
  );
  await handleHookEvent(
    "codex",
    { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "turn-1", transcript_path: transcript, cwd: "C:/fake" },
    { paths: repoPaths, gitCommonDir: "C:/fake/.git", cwd: "C:/fake" },
  );

  assert.equal(getClaimant(repoPaths, "continued", { CODEX_THREAD_ID: "s" }, "C:/fake").turnId, "turn-2");
});

test("Codex automatic continuation remains claimable and its Stop releases gates", async () => {
  const home = temporaryDirectory();
  const runtime = temporaryDirectory("turngate-codex-continuation-");
  const transcript = join(temporaryDirectory(), "codex.jsonl");
  const common = getGitCommonDir(process.cwd());
  const repoPaths = getRepositoryPaths(common, runtime);
  const base = { paths: repoPaths, gitCommonDir: common, cwd: process.cwd(), runtimeRoot: runtime };
  setupHooks({ host: "all", home, executablePath: "C:/tool/cli.mjs" });
  writeFileSync(transcript, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } })}\n`);
  await handleHookEvent(
    "codex",
    { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "turn-1", transcript_path: transcript, cwd: process.cwd() },
    base,
  );
  await handleHookEvent("codex", { hook_event_name: "Stop", session_id: "s", turn_id: "turn-1", cwd: process.cwd() }, base);
  writeFileSync(
    transcript,
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
    ].map((event) => JSON.stringify(event)).join("\n"),
  );

  const claimant = getClaimant(repoPaths, "automatic continuation", { CODEX_THREAD_ID: "s" }, process.cwd());
  assert.equal(claimant.turnId, "turn-2");
  await claim(repoPaths, ["git:main"], claimant);
  assert.equal((await status(repoPaths)).gates["git:main"].turnId, "turn-2");
  const activeDoctor = doctor({ cwd: process.cwd(), home, env: { ...process.env, TURNGATE_HOME: runtime, CODEX_THREAD_ID: "s" } });
  assert.equal(activeDoctor.checks.find((check) => check.name === "active-owner").ok, true);
  assert.match(activeDoctor.checks.find((check) => check.name === "active-owner").detail, /source=transcript/);

  const stopped = await handleHookEvent("codex", { hook_event_name: "Stop", session_id: "s", turn_id: "turn-2", cwd: process.cwd() }, base);
  assert.equal(stopped.status, "released");
  assert.equal(stopped.reason, "stale-turn");
  assert.deepEqual((await status(repoPaths)).gates, {});
});

test("Codex transcript discovery bootstraps a session that predates hook setup", async () => {
  const home = temporaryDirectory();
  const codexHome = join(home, ".codex");
  const transcriptDirectory = join(codexHome, "sessions", "2026", "07", "14");
  const transcript = join(transcriptDirectory, "rollout-2026-07-14T00-00-00-s.jsonl");
  const runtime = temporaryDirectory("turngate-codex-discovery-");
  const common = getGitCommonDir(process.cwd());
  const repoPaths = getRepositoryPaths(common, runtime);
  const base = { paths: repoPaths, gitCommonDir: common, cwd: process.cwd(), runtimeRoot: runtime };
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: "s", TURNGATE_HOME: runtime };
  mkdirSync(transcriptDirectory, { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-discovered" } })}\n`);
  setupHooks({ host: "all", home, executablePath: "C:/tool/cli.mjs" });

  const claimant = getClaimant(repoPaths, "discovered", env, process.cwd());
  assert.equal(claimant.turnId, "turn-discovered");
  assert.equal(claimant.transcriptPath, transcript);
  await claim(repoPaths, ["git:main"], claimant);
  assert.equal((await status(repoPaths)).gates["git:main"].turnId, "turn-discovered");
  const activeDoctor = doctor({ cwd: process.cwd(), home, env });
  assert.equal(activeDoctor.checks.find((check) => check.name === "active-owner").ok, true);
  assert.match(activeDoctor.checks.find((check) => check.name === "active-owner").detail, /source=transcript-discovery/);

  const stopped = await handleHookEvent(
    "codex",
    { hook_event_name: "Stop", session_id: "s", turn_id: "turn-discovered", cwd: process.cwd() },
    base,
  );
  assert.equal(stopped.status, "released");
  assert.equal(stopped.reason, "session-not-registered");
  assert.deepEqual((await status(repoPaths)).gates, {});
});

test("Codex transcript activity parsing discards non-structural bodies", () => {
  const transcript = join(temporaryDirectory(), "codex-private.jsonl");
  writeFileSync(
    transcript,
    [
      { type: "response_item", payload: { role: "user", content: "must-not-be-returned" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", message: "also-private" } },
    ].map((event) => JSON.stringify(event)).join("\n"),
  );

  const events = readCodexTurnEvents(transcript);
  assert.deepEqual(events, [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }]);
  assert.doesNotMatch(JSON.stringify(events), /private|must-not-be-returned/);
});

test("Claude claimant ignores interruption markers from earlier turns", async () => {
  const repoPaths = paths();
  const transcript = join(temporaryDirectory(), "claude.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "[Request interrupted by user]" } })}\n`);
  await handleHookEvent(
    "claude",
    { hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "turn-2", transcript_path: transcript, cwd: "C:/fake" },
    { paths: repoPaths, gitCommonDir: "C:/fake/.git", cwd: "C:/fake" },
  );

  const claimant = getClaimant(repoPaths, "current", { TURNGATE_PROVIDER: "claude", TURNGATE_SESSION_ID: "s" }, "C:/fake");
  assert.equal(claimant.turnId, "turn-2");
});

test("hook failures are recorded without prompt or assistant bodies", async () => {
  const repoPaths = paths();
  await assert.rejects(
    handleHookEvent(
      "codex",
      { hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "C:/fake", prompt: "must-not-be-stored" },
      { paths: repoPaths, gitCommonDir: "C:/fake/.git", cwd: "C:/fake" },
    ),
    /missing turn_id/,
  );

  const observation = readHookObservation(repoPaths.runtimeRoot, "codex", "s");
  assert.equal(observation.status, "failed");
  assert.equal(observation.event, "UserPromptSubmit");
  assert.equal(observation.turnId, "");
  assert.doesNotMatch(JSON.stringify(observation), /must-not-be-stored/);
});

test("setup merges existing hooks, is idempotent, and dry-run does not write", () => {
  const home = temporaryDirectory();
  const codexFile = join(home, ".codex", "hooks.json");
  const first = setupHooks({ host: "codex", home, executablePath: "C:/tool/cli.mjs" });
  assert.equal(first[0].changed, true);
  const config = JSON.parse(readFileSync(codexFile, "utf8"));
  const installedCommand = config.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(installedCommand, /node(?:\.exe)?/i);
  assert.doesNotMatch(installedCommand, /^node\s/i);
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

test("setup replaces legacy managed hooks without removing unrelated hooks", () => {
  const legacy = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: 'node "C:/node_modules/codex-concurrency/src/cli.mjs" hook codex', statusMessage: "Updating concurrency ownership" }] },
        { hooks: [{ type: "command", command: "other-tool hook codex" }] },
      ],
    },
  };
  const result = mergeHookConfig(legacy, "codex", "C:/node_modules/turngate/src/cli.mjs");
  const commands = result.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.equal(commands.some((command) => command.includes("codex-concurrency")), false);
  assert.equal(commands.some((command) => command === "other-tool hook codex"), true);
  assert.equal(commands.some((command) => command.includes("turngate")), true);
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

test("doctor reports missing hooks, execution state, and a writable runtime", () => {
  const home = temporaryDirectory();
  const runtime = temporaryDirectory("turngate-doctor-");
  const result = doctor({ cwd: process.cwd(), home, env: { ...process.env, TURNGATE_HOME: runtime, CODEX_THREAD_ID: "" } });
  assert.equal(result.checks.find((check) => check.name === "codex-hooks").ok, false);
  assert.equal(result.checks.find((check) => check.name === "claude-hooks").ok, false);
  assert.equal(result.checks.find((check) => check.name === "runtime-state").ok, true);
  assert.match(result.checks.find((check) => check.name === "codex-hook-observed").detail, /not observed/);
});

test("doctor fails when the current Codex session is completed", async () => {
  const home = temporaryDirectory();
  const runtime = temporaryDirectory("turngate-doctor-active-");
  setupHooks({ host: "all", home, executablePath: "C:/tool/cli.mjs" });
  const common = getGitCommonDir(process.cwd());
  const repoPaths = getRepositoryPaths(common, runtime);
  const base = { paths: repoPaths, gitCommonDir: common, cwd: process.cwd(), runtimeRoot: runtime };
  await handleHookEvent("codex", { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "turn-1", transcript_path: "", cwd: process.cwd() }, base);
  await handleHookEvent("codex", { hook_event_name: "Stop", session_id: "s", turn_id: "turn-1", cwd: process.cwd() }, base);

  const result = doctor({ cwd: process.cwd(), home, env: { ...process.env, TURNGATE_HOME: runtime, CODEX_THREAD_ID: "s" } });
  assert.equal(result.checks.find((check) => check.name === "codex-hook-observed").ok, true);
  assert.equal(result.checks.find((check) => check.name === "active-owner").ok, false);
  assert.equal(result.ok, false);
});

test("lifecycle file names do not expose provider session ids", () => {
  const repoPaths = paths();
  const file = lifecycleFile(repoPaths, "claude", "secret-looking-session-id");
  assert.doesNotMatch(file, /secret-looking-session-id/);
  writeLifecycle(repoPaths, { provider: "claude", sessionId: "s", turnId: "t", status: "active" });
  assert.equal(loadState(repoPaths.stateFile).version, 2);
});
