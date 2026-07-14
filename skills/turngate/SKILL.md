---
name: turngate
description: Enable Turngate workflows for Codex and Claude Code. Use this skill only when the user explicitly requests Turngate or the current repository instructions explicitly opt in; global installation alone never activates locking policy.
---

# Turngate enablement

This global skill makes Turngate available. It does not decide that a repository must use Turngate.

## Activation boundary

- Do not run any `turngate` command merely because this skill is installed, a branch is shared, or a deployment is sensitive.
- Activate Turngate only when the current user request explicitly names it or current repository instructions explicitly opt in.
- Repository instructions own the protected resource names, claim timing, and required verification. Do not invent policy that the repository has not declared.
- If no explicit opt-in exists, continue without Turngate and do not block the task on Turngate diagnostics.
- The Turngate source repository is not automatically opted in to protecting its own development.

## When a repository opts in

Follow that repository's instructions exactly. When they require a claim:

1. Claim every declared resource atomically with `turngate claim <resource>...` before the protected mutation.
2. If the claim waits, blocks, or times out, leave the declared resources unchanged and report the identified owner.
3. Keep ownership through the repository-required verification steps.
4. Let the host lifecycle hook release ownership at turn end. Do not synthesize or force a release.

Use `turngate status <resource>...` only when the user or repository policy asks for ownership inspection. Never treat an available gate as proof that the current turn is registered; use `turngate doctor` when a required claim cannot identify the active turn.

## Setup support

Installation and hook changes are administrative enablement, not repository activation. Run `turngate setup --host codex|claude|all` only when the user explicitly asks to install or repair Turngate. Preserve unrelated hooks. After changing a Codex hook definition, ask the user to review and trust its new hash with `/hooks`.

`turngate doctor` distinguishes configuration, observed hook execution, and active ownership. It cannot read Codex's private trust decision directly; a successful observed hook event is runtime evidence that the hook executed.

## Data boundary

- Never store or echo prompt bodies, assistant bodies, or credentials as gate metadata.
- Gate and hook state may contain only structural lifecycle metadata and sanitized error messages.
