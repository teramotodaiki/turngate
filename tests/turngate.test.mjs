import test from "node:test";
import assert from "node:assert/strict";

import * as turngate from "../src/turngate.mjs";

test("turngate module re-exports the public implementation", () => {
  assert.equal(typeof turngate.claimResources, "function");
  assert.equal(typeof turngate.handleHookEvent, "function");
  assert.equal(typeof turngate.runCli, "function");
  assert.equal(turngate.STATE_VERSION, 2);
});
