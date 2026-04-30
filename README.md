# codex-concurrency

`codex-concurrency` is a zero-config CLI for coordinating Codex work that touches shared repository resources.

It exists to prevent multiple Codex turns from acting on the same shared target at the same time. Typical examples are:

- merging different worktrees into the same local `main`
- deploying to the same environment
- running a post-deploy verification flow while another Codex turn tries to overwrite the same environment
- protecting any other repository-local shared thing that should only be owned by one active Codex turn at a time

This tool is intentionally small:

- no checked-in config
- no daemon
- no manual unlock
- no repository-specific logic

Instead, each repository chooses its own resource names in its docs or operational skills, and `codex-concurrency` only enforces ownership.

## What problem it solves

When multiple Codex turns work in parallel, they can easily step on each other even if Git itself is fine.

Examples:

- turn A merges a branch into local `main`
- turn B also tries to merge into local `main`
- turn A deploys to production and starts verification
- turn B deploys to production before turn A finishes checking
- turn A is now observing a different production state than the one it deployed

Plain lock files are not a good fit here because they are easy to forget to release. `codex-concurrency` avoids that class of failure by tying ownership to a Codex turn instead of relying on manual unlock.

## Core idea

You decide a set of resource names such as:

```text
git:branch:main
deploy:env:production
deploy:env:staging
```

Then a Codex turn claims the resources it needs:

```bash
codex-concurrency claim git:branch:main
codex-concurrency claim git:branch:main deploy:env:production
codex-concurrency claim deploy:env:staging
```

If another active turn already owns any requested resource, the claim waits until ownership is reclaimable or the timeout expires.

If the same active turn claims additional resources, the ownership is expanded.

When the owning turn completes or the same thread moves on to a later turn, the resources become reclaimable automatically.

By default, `claim` waits for blocked resources to become reclaimable for up to 10 minutes. Use `--no-wait` when a workflow needs the older fail-fast behavior.

## Commands

### `claim`

Claims one or more resources for the current Codex turn.

```bash
codex-concurrency claim <resource>... [--label <text>] [--json] [--wait|--no-wait] [--timeout <duration>] [--poll-interval <duration>]
```

Examples:

```bash
codex-concurrency claim git:branch:main
codex-concurrency claim git:branch:main deploy:env:production
codex-concurrency claim deploy:env:staging --label "staging deploy"
```

Behavior:

- succeeds if all requested resources are free
- succeeds if the same active turn already owns some of them and needs to add more
- waits if any requested resource is owned by another active turn
- fails after the wait timeout if another active turn still owns any requested resource
- may reclaim resources from inactive owners during the same operation

Waiting:

- enabled by default for `claim`
- `--wait` can be used to make that behavior explicit
- `--no-wait` restores fail-fast behavior
- default timeout: `10m`
- maximum timeout: `10m`
- default poll interval: `5s`
- duration values accept `ms`, `s`, or `m`, for example `500ms`, `5s`, `10m`
- an immediate wait notice and repeated progress messages are written to stderr, so Codex can see that the CLI is still waiting while `--json` keeps stdout machine-readable

Possible statuses:

- `claimed`: all requested resources were free
- `expanded`: the same active turn already owned some requested resources and added more
- `already-owner`: the same active turn already owned all requested resources
- `reclaimed`: one or more inactive owners were replaced
- `blocked`: another active turn owns at least one requested resource
- `timeout`: only emitted by the CLI when waiting expires

### `status`

Shows current ownership after pruning inactive owners.

```bash
codex-concurrency status [<resource>...] [--json]
```

Examples:

```bash
codex-concurrency status
codex-concurrency status git:branch:main deploy:env:production
codex-concurrency status --json
```

## Typical usage patterns

### Protecting local `main`

```bash
codex-concurrency claim git:branch:main --label "main merge"
```

Use this before a workflow that mutates the canonical local `main`.

### Protecting a production release from local `main`

```bash
codex-concurrency claim git:branch:main deploy:env:production --label "production deploy"
```

Use this when the deploy reads from local `main` and also overwrites production.

### Protecting a staging deploy from a feature branch

```bash
codex-concurrency claim deploy:env:staging --label "staging deploy"
```

Use this when the deploy does not depend on local `main`, but it does overwrite staging.

### Expanding ownership in the same turn

This is an important pattern.

Example:

1. claim `git:branch:main` before merge
2. merge into local `main`
3. in the same turn, claim `git:branch:main deploy:env:production`

The second claim succeeds because the same active turn already owns `git:branch:main`.

## How ownership works

`codex-concurrency` does not use PID lifetime and does not depend on a long-running background process.

Instead, it identifies the current owner as:

- current `CODEX_THREAD_ID`
- current active turn in that thread

The owner record stored in state includes:

- thread id
- thread name, if available
- turn id
- session file path
- current working directory
- current Git branch
- optional label
- claimed timestamp

The most important detail is that ownership is attached to a Codex turn, not a shell process.

## How activity is detected

The tool reads the local Codex session log under `CODEX_HOME` and checks whether the owning turn is still the current active turn in that thread.

Ownership is treated as inactive and can be pruned or reclaimed when either:

- the owning turn emits `task_complete`
- a later turn starts in the same thread, even if the older turn never emitted `task_complete`

That means:

- no manual unlock is required
- abandoned claims are released once the session records completion or a later turn
- a new turn can reclaim resources owned by a completed or superseded turn

This behavior is deliberate. If a turn ends while waiting for a human response and the same thread later continues with a new turn, the older turn's resources are considered releasable.

## Where state is stored

Runtime state is repository-local and lives under the Git common directory:

```text
$(git rev-parse --git-common-dir)/codex-concurrency/state.json
```

This matters because Git worktrees share the same common dir. As a result:

- all worktrees of the same repository see the same concurrency state
- unrelated repositories do not share state

The state lock file is stored alongside it:

```text
$(git rev-parse --git-common-dir)/codex-concurrency/state.lock
```

## Why there is no checked-in config

Different repositories need different resource names, and those names are operational policy rather than tool configuration.

This tool intentionally does not impose:

- a resource registry
- presets
- repository-specific commands
- checked-in config files

The repository should define its resource vocabulary in its own docs, AGENTS, or operational skills.

## How mutual exclusion is enforced

The tool uses two layers:

1. a small file lock to serialize updates to the state file
2. turn-based ownership records in the state file itself

The file lock only protects state mutation. It is not the long-lived protection model.

Long-lived protection comes from the claimed resources stored in `state.json`, which are tied to active Codex turns.

When `claim` is waiting, it does not hold the state file lock while sleeping. Each retry briefly takes the file lock, prunes completed owners, attempts the claim, then releases the file lock before the next poll. This keeps multiple waiting Codex turns from blocking each other at the state-file layer.

## What it guarantees

- only one active Codex turn can own a given resource at a time
- claims over multiple resources are atomic
- the same active turn can safely expand its claim set
- ownership is shared across Git worktrees of the same repository
- inactive owners are reclaimed automatically

## What it does not guarantee

- it does not prevent someone from bypassing the tool
- it does not understand repository semantics by itself
- it does not know which resources your workflow should claim
- it does not coordinate across different repositories
- it does not guarantee strict FIFO ordering among multiple waiters
- it does not replace Git conflict resolution

You still need to choose sensible resource names and call the tool at the right points in your workflow.

## Requirements

- a Git repository
- a Codex environment with `CODEX_THREAD_ID`
- local Codex session logs under `CODEX_HOME` or `~/.codex`
- Node.js 20+
- `lockf` available on the host system

If the tool cannot determine the current Codex thread or current active turn, it fails instead of guessing.

## Install

This tool is intended for global install in a local operator environment.

```bash
npm install -g codex-concurrency
```

or:

```bash
pnpm add -g codex-concurrency
```

## Examples

Show everything currently owned in this repository:

```bash
codex-concurrency status --json
```

Claim local `main` before a merge workflow:

```bash
codex-concurrency claim git:branch:main --label "worktree-main-merge"
```

Claim `main` plus production before a deploy workflow:

```bash
codex-concurrency claim git:branch:main deploy:env:production --label "production deploy"
```

Claim staging only from a feature branch workflow:

```bash
codex-concurrency claim deploy:env:staging --label "staging deploy"
```

Fail fast instead of waiting:

```bash
codex-concurrency claim deploy:env:staging --label "staging deploy" --no-wait
```

## Naming resources

Use names that describe the shared thing being protected, not the command being run.

Good:

```text
git:branch:main
deploy:env:production
deploy:env:staging
db:schema:primary
dns:zone:example.com
```

Less good:

```text
run-prod
step-5
deploy-script
```

The resource should answer: "what shared target is being protected?"

## Design philosophy

`codex-concurrency` is meant to be boring infrastructure:

- visible ownership
- repository-local scope
- zero checked-in config
- no hidden daemon
- no manual unlock ceremony

The repository owns the policy. The tool only enforces it.
