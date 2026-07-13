---
name: codex-concurrency
description: Coordinate exclusive repository resources across concurrent Codex and Claude Code turns on macOS or Windows. Use before modifying a shared branch, deployment environment, database schema, generated artifact, or other resource that another local coding-agent turn could also change, and when checking whether such a resource is already owned.
---

# Codex Concurrency

Use `codex-concurrency` to acquire the shared gate before starting protected work. Treat ownership as belonging to the current agent turn, not to the shell or the human user.

## Protect work

1. Identify every resource the operation will mutate. Use stable, explicit names such as `git:branch:main`, `deploy:env:production`, or `database:schema:voicebot`.
2. Claim all required resources in one command before the first mutation:

   ```sh
   codex-concurrency claim <resource>...
   ```

3. If the command waits, do not mutate protected resources while waiting. If it times out or reports another owner, explain the conflict and leave those resources unchanged.
4. Perform protected work only after the claim succeeds.
5. Do not release the gate manually. The host hook MUST release it when the turn ends. Recover interruption or host failure automatically at the next `claim` or `status` observation.

Claim every resource together when an operation spans multiple targets. Do not claim them one by one because another turn could acquire a partial set between commands.

## Inspect ownership

Run `codex-concurrency status <resource>...` to inspect specific resources, or `codex-concurrency status` for the repository. Status also prunes owners that are proven inactive.

Use `--json` only when structured output is useful. Use `--no-wait` when the task must report a conflict immediately rather than wait. Never infer ownership from process names, files, or conversation text when the CLI cannot identify the active turn.

## Handle lifecycle and setup

If `claim` cannot identify the active owner or reports missing or untrusted hooks, stop before protected mutation and run:

```sh
codex-concurrency doctor
```

Report the failing check. Do not bypass it with a guessed session ID, a manual state edit, a force option, or a synthetic release.

Treat installation and hook changes as explicit administrative work. Run `codex-concurrency setup --host codex|claude|all` only when the user asks to install or repair integration. Preserve unrelated host hooks. After Codex setup, require the user to review and trust the hook definitions with `/hooks` before relying on claims.

On Claude Code, retain ownership when a Stop event reports background tasks or session crons. Consider the turn finished only after it becomes completely quiescent.

## Safety rules

- Never store or echo prompt bodies, assistant bodies, or credentials as gate metadata.
- Never expose or add a normal-use `release` or `--force` workflow.
- Never mutate a protected resource after a failed, blocked, or timed-out claim.
- Keep the claim through verification steps in the same protected operation; automatic turn-end release is mandatory.
