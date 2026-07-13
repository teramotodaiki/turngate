import test from "node:test";
import assert from "node:assert/strict";

import * as compatibility from "../src/codex-concurrency.mjs";

test("legacy module path re-exports the v2 public implementation", () => {
  assert.equal(typeof compatibility.claimResources, "function");
  assert.equal(typeof compatibility.handleHookEvent, "function");
  assert.equal(typeof compatibility.runCli, "function");
  assert.equal(compatibility.STATE_VERSION, 2);
});
