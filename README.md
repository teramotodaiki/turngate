# codex-concurrency

`codex-concurrency` is a zero-config CLI for coordinating Codex work that touches shared repository resources.

It uses `CODEX_THREAD_ID` plus the local Codex session log to hold resource claims until the owning turn completes.

Runtime state is stored under:

```text
$(git rev-parse --git-common-dir)/codex-concurrency/state.json
```

Examples:

```bash
codex-concurrency claim git:branch:main
codex-concurrency claim git:branch:main deploy:env:production
codex-concurrency status git:branch:main deploy:env:production
```
