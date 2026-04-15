import test from "node:test";
import assert from "node:assert/strict";

import {
  claimResources,
  createEmptyState,
  getCurrentTurnIdFromEvents,
  getLatestTurnIdFromEvents,
  getStatePaths,
  hasTaskCompleteForTurn,
  normalizeResourceNames,
  normalizeState,
  pruneInactiveGateRecords,
} from "../src/codex-concurrency.mjs";

test("getLatestTurnIdFromEvents は最後の turn_context を返す", () => {
  const events = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "turn_context", payload: { turn_id: "turn-2" } },
    { type: "turn_context", payload: { turn_id: "turn-3" } },
  ];

  assert.equal(getLatestTurnIdFromEvents(events), "turn-3");
});

test("getLatestTurnIdFromEvents は turn_context が無ければ task_started を使う", () => {
  const events = [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }];

  assert.equal(getLatestTurnIdFromEvents(events), "turn-1");
});

test("getCurrentTurnIdFromEvents は完了済みでない最新 turn を返す", () => {
  const events = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "turn_context", payload: { turn_id: "turn-1" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
  ];

  assert.equal(getCurrentTurnIdFromEvents(events), "turn-2");
});

test("hasTaskCompleteForTurn は一致する task_complete だけを拾う", () => {
  const events = [
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } },
  ];

  assert.equal(hasTaskCompleteForTurn(events, "turn-2"), true);
  assert.equal(hasTaskCompleteForTurn(events, "turn-3"), false);
});

test("normalizeState は壊れた値を空 state へ直す", () => {
  assert.deepEqual(normalizeState(null), createEmptyState());
  assert.deepEqual(normalizeState({ gates: [] }), createEmptyState());
});

test("normalizeResourceNames は空要素と重複を落とす", () => {
  assert.deepEqual(normalizeResourceNames(["git:branch:main", "", "git:branch:main", "deploy:env:production"]), [
    "git:branch:main",
    "deploy:env:production",
  ]);
});

test("claimResources は空き resource 群をまとめて claim できる", () => {
  const claimant = { threadId: "thread-a", turnId: "turn-a", claimedAt: "2026-04-15T00:00:00.000Z" };
  const result = claimResources(createEmptyState(), ["git:branch:main", "deploy:env:production"], claimant, () => true);

  assert.equal(result.status, "claimed");
  assert.deepEqual(result.state.gates["git:branch:main"], claimant);
  assert.deepEqual(result.state.gates["deploy:env:production"], claimant);
});

test("claimResources は同じ turn の再 claim を許可する", () => {
  const claimant = { threadId: "thread-a", turnId: "turn-a", claimedAt: "2026-04-15T00:00:00.000Z" };
  const state = {
    version: 1,
    updatedAt: null,
    gates: {
      "git:branch:main": claimant,
    },
  };

  const result = claimResources(state, ["git:branch:main"], { ...claimant, label: "main merge" }, () => true);

  assert.equal(result.status, "already-owner");
  assert.equal(result.state.gates["git:branch:main"].label, "main merge");
});

test("claimResources は同じ owner が resource を追加 claim できる", () => {
  const claimant = { threadId: "thread-a", turnId: "turn-a", claimedAt: "2026-04-15T00:00:00.000Z" };
  const state = {
    version: 1,
    updatedAt: null,
    gates: {
      "git:branch:main": claimant,
    },
  };

  const result = claimResources(state, ["git:branch:main", "deploy:env:production"], claimant, () => true);

  assert.equal(result.status, "expanded");
  assert.deepEqual(result.state.gates["deploy:env:production"], claimant);
});

test("claimResources は別 turn の active owner を block する", () => {
  const activeOwner = { threadId: "thread-a", turnId: "turn-a", claimedAt: "2026-04-15T00:00:00.000Z" };
  const claimant = { threadId: "thread-b", turnId: "turn-b", claimedAt: "2026-04-15T00:01:00.000Z" };
  const state = {
    version: 1,
    updatedAt: null,
    gates: {
      "deploy:env:production": activeOwner,
    },
  };

  const result = claimResources(state, ["deploy:env:production"], claimant, () => true);

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocked, [{ resource: "deploy:env:production", owner: activeOwner }]);
});

test("claimResources は requested resource のどれかが block されていれば全体を止める", () => {
  const mainOwner = { threadId: "thread-a", turnId: "turn-a", claimedAt: "2026-04-15T00:00:00.000Z" };
  const deployOwner = { threadId: "thread-b", turnId: "turn-b", claimedAt: "2026-04-15T00:00:00.000Z" };
  const claimant = { threadId: "thread-c", turnId: "turn-c", claimedAt: "2026-04-15T00:01:00.000Z" };
  const state = {
    version: 1,
    updatedAt: null,
    gates: {
      "git:branch:main": mainOwner,
      "deploy:env:production": deployOwner,
    },
  };

  const result = claimResources(state, ["git:branch:main", "deploy:env:production"], claimant, (owner) => owner.turnId !== "turn-a");

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocked, [{ resource: "deploy:env:production", owner: deployOwner }]);
  assert.equal(result.state.gates["git:branch:main"], mainOwner);
  assert.equal(result.state.gates["deploy:env:production"], deployOwner);
});

test("claimResources は inactive owner を上書きできる", () => {
  const inactiveOwner = { threadId: "thread-a", turnId: "turn-a", claimedAt: "2026-04-15T00:00:00.000Z" };
  const claimant = { threadId: "thread-b", turnId: "turn-b", claimedAt: "2026-04-15T00:01:00.000Z" };
  const state = {
    version: 1,
    updatedAt: null,
    gates: {
      "deploy:env:production": inactiveOwner,
    },
  };

  const result = claimResources(state, ["deploy:env:production"], claimant, () => false);

  assert.equal(result.status, "reclaimed");
  assert.deepEqual(result.state.gates["deploy:env:production"], claimant);
});

test("pruneInactiveGateRecords は inactive gate だけ消す", () => {
  const state = {
    version: 1,
    updatedAt: null,
    gates: {
      "git:branch:main": { threadId: "thread-a", turnId: "turn-a" },
      "deploy:env:staging": { threadId: "thread-b", turnId: "turn-b" },
    },
  };

  const result = pruneInactiveGateRecords(state, (owner) => owner.turnId === "turn-b");

  assert.equal(result.changed, true);
  assert.deepEqual(result.state.gates, {
    "deploy:env:staging": { threadId: "thread-b", turnId: "turn-b" },
  });
});

test("getStatePaths は git common dir 配下の単一 state.json を返す", () => {
  const paths = getStatePaths("/tmp/example/.git");

  assert.equal(paths.stateFile, "/tmp/example/.git/codex-concurrency/state.json");
  assert.equal(paths.lockFile, "/tmp/example/.git/codex-concurrency/state.lock");
});
