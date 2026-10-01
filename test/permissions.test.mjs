import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseInput } from "../src/core/contracts.mjs";
import { codex } from "../src/adapters/codex.mjs";
import { canonicalWritableRoots } from "../src/platform/scopes.mjs";

const input = {
  cwd: "/fixture",
  delegation_id: "permission-test",
  prompt: "Fixture only",
  model: "gpt-6.1-sol",
  effort: "high",
  sandbox: "workspace-write",
};

test("omitted permission overrides preserve existing defaults; explicit false and empty roots survive", () => {
  const parsed = parseInput("codex", input);
  assert.equal(parsed.network_access, undefined);
  assert.equal(parsed.writable_roots, undefined);
  assert.ok(
    !codex.args(parsed).some((arg) => arg.includes("sandbox_workspace_write")),
  );
  const explicit = codex.args(
    parseInput("codex", {
      ...input,
      network_access: false,
      writable_roots: [],
    }),
  );
  assert.ok(explicit.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(explicit.includes("sandbox_workspace_write.writable_roots=[]"));
});

test("permission contracts reject wrong types, excessive roots and unsupported provider combinations", () => {
  for (const fields of [
    { network_access: "true" },
    { network_access: null },
    { writable_roots: "/fixture" },
    { writable_roots: [1] },
    { writable_roots: Array.from({ length: 17 }, () => "/fixture") },
    { sandbox: "read-only", network_access: true },
    { sandbox: "read-only", writable_roots: [] },
  ])
    assert.throws(() => parseInput("codex", { ...input, ...fields }));
  const { sandbox: ignored, ...claude } = input;
  assert.equal(ignored, "workspace-write");
  assert.throws(() => parseInput("claude", { ...claude, writable_roots: [] }));
  assert.throws(() =>
    parseInput("claude", { ...claude, network_access: false }),
  );
});

test("control characters in writable paths and symlink targets are rejected before CLI serialization", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "farcall-controls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalid = path.join(root, "form\ffeed");
  await mkdir(invalid);
  const alias = path.join(root, "alias");
  await symlink(invalid, alias);
  await assert.rejects(canonicalWritableRoots([invalid]), /control characters/);
  await assert.rejects(canonicalWritableRoots([alias]), /control characters/);
});

test("full access is explicit and never presents workspace-only overrides as restrictions", () => {
  const { sandbox: ignored, ...defaults } = input;
  assert.equal(ignored, "workspace-write");
  assert.equal(parseInput("codex", defaults).sandbox, "read-only");
  const full = parseInput("codex", {
    ...input,
    sandbox: "danger-full-access",
    writable_roots: ["/coordination-only"],
  });
  const args = codex.args(full);
  assert.equal(args[args.indexOf("--sandbox") + 1], "danger-full-access");
  assert.ok(!args.some((arg) => arg.includes("sandbox_workspace_write")));
  assert.ok(args.includes('approval_policy="never"'));
  for (const network_access of [false, true])
    assert.throws(
      () => parseInput("codex", { ...full, network_access }),
      /network_access requires sandbox workspace-write/,
    );
});
