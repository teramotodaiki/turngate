import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the global skill enables Turngate without activating it for every repository", () => {
  const skill = readFileSync(new URL("../skills/turngate/SKILL.md", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../skills/turngate/agents/openai.yaml", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  assert.match(skill, /explicit(?:ly)? opt[ -]in/i);
  assert.match(skill, /do not run .*turngate/i);
  assert.doesNotMatch(skill, /Use `turngate` to acquire the shared gate before starting protected work/i);
  assert.doesNotMatch(agent, /Use \$turngate before modifying this repository/i);
  assert.match(readme, /global.*enablement/i);
  assert.match(readme, /repository.*opt[ -]in/i);
  assert.ok(root.endsWith("turngate\\") || root.endsWith("turngate/"));
});
