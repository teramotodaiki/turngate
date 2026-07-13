# turngate

`turngate` coordinates shared repository operations across local Codex and Claude Code turns.

It supports the four local combinations below with one shared gate state per Git repository:

| Host | macOS | Windows |
| --- | --- | --- |
| Codex | Supported | Supported |
| Claude Code | Supported | Supported |

Typical protected resources are local `main`, a deployment environment, a database schema, or any other target that must not be changed by two active agent turns at once.

## Guarantees

- one active turn can own a resource at a time
- multi-resource claims are atomic
- all worktrees that share a Git common directory share the same gates
- Codex and Claude Code contend for the same gates
- a turn can add resources to its existing ownership
- no lease or wall-clock expiry is used
- no manual release command is required or provided
- completed, superseded, interrupted, or crashed owners are reclaimed automatically

Normal completion hooks release gates immediately. If a hook cannot run, `claim` and `status` prune owners from lifecycle state and transcripts before returning results.

Claude Code may emit `Stop` while background tasks or session wake-ups remain. In that case ownership is retained until a later quiescent `Stop` or `SessionEnd`.

## Requirements

- Node.js 20 or newer
- Git
- local Codex and/or Claude Code
- macOS or native Windows

The tool intentionally fails closed if it cannot identify an active configured agent turn.

## Install and configure

Install globally:

```bash
pnpm add -g turngate
```

or:

```bash
npm install -g turngate
```

Install the user-level lifecycle hooks for both hosts:

```bash
turngate setup
```

The package also includes the `skills/turngate` agent skill. Copy or link that directory into the host's skill directory when distributing the CLI so coding agents consistently claim protected resources before mutation. The skill does not replace lifecycle hooks; automatic turn-end release still depends on `setup`.

Configure only one host when necessary:

```bash
turngate setup --host codex
turngate setup --host claude
```

Preview changes without writing settings:

```bash
turngate setup --dry-run --json
```

`setup` merges its hook groups into existing `~/.codex/hooks.json` and `~/.claude/settings.json`; it does not replace unrelated hooks. Re-running it updates the installed command paths without adding duplicates.

Codex requires non-managed command hooks to be reviewed. After setup, open `/hooks` in Codex and trust the new definitions. Until the hooks are installed and trusted, `claim` fails instead of inventing an owner.

Validate the installation:

```bash
turngate doctor
```

## Commands

### `claim`

```bash
turngate claim <resource>... [--label <text>] [--no-wait] [--timeout <duration>] [--poll-interval <duration>] [--json]
```

Examples:

```bash
turngate claim git:branch:main
turngate claim git:branch:main deploy:env:production --label "production deploy"
turngate claim deploy:env:preview --no-wait
```

Claims wait for up to 10 minutes by default. Durations accept `ms`, `s`, and `m`. `--no-wait` reports an active owner immediately.

### `status`

```bash
turngate status [resource...] [--json]
```

`status` first removes owners proven inactive, then shows all gates or the requested resources.

### `setup`

```bash
turngate setup [--host codex|claude|all] [--dry-run] [--json]
```

The default host is `all`.

### `doctor`

```bash
turngate doctor [--json]
```

Checks Node and host availability, hook installation, runtime-state writability, active owner registration, and legacy state.

## Ownership lifecycle

Each gate stores only structural metadata:

```text
provider, sessionId, turnId, transcriptPath, processFingerprint,
cwd, branch, label, claimedAt
```

Prompt text, assistant text, hook output bodies, credentials, and environment secrets are never copied into gate or lifecycle state.

Codex ownership uses turn-scoped `UserPromptSubmit` and `Stop` hooks plus Codex session events. Claude Code ownership uses `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, and `SessionEnd`, plus structural transcript markers for interrupted turns.

A later prompt in the same session supersedes the previous turn. On Claude Code, an exact generated interruption marker also makes the old turn reclaimable. A dead Claude host process is detected with its PID and process-start fingerprint, so PID reuse does not reclaim a live owner incorrectly.

## Shared state and locking

The Git common directory is canonicalized and hashed into a repository ID. Runtime files live under:

```text
${TURNGATE_HOME:-<os-temp>/turngate}/repositories/<repository-id>/
```

This location is writable from normal Codex sandboxes on macOS and Windows even when a linked worktree's Git common directory is outside the writable workspace. Set `TURNGATE_HOME` only when every participating host uses the same override.

State mutation is serialized with an atomic directory lock. Lock ownership records the writer PID and hostname. A lock is recovered only when its writer is no longer alive; gate ownership itself never expires by time.

## Migrating from codex-concurrency

`turngate` intentionally uses a new command, package, skill, environment-variable prefix, hook path, and runtime directory. Do not run it alongside `codex-concurrency`.

1. Finish all active Codex and Claude Code turns using shared resources.
2. Upgrade the global package.
3. Run `turngate setup --host all`; setup replaces managed `codex-concurrency` hooks while preserving unrelated hooks.
4. Review the Codex hooks with `/hooks`.
5. Run `turngate doctor`.

Legacy `.git/codex-concurrency/state.json` files are reported by `doctor` but are not removed or reused.

## Development

```bash
npm test
```

The suite covers state semantics, atomic multi-resource claims, concurrent directory locking, Codex and Claude lifecycle fixtures, interruptions, complete-quiescence behavior, and idempotent setup.
