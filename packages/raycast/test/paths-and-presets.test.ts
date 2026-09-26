import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "../src/lib/paths";
import { BUILTIN_PRESETS, loadPresetLibrary } from "../src/lib/presets";
import { diffZones, loadLayouts } from "../src/lib/layouts";
import type { Zone } from "@ghostkeys/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeFakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ghostkeys-raycast-test-"));
  mkdirSync(join(root, "presets", "layouts"), { recursive: true });
  mkdirSync(join(root, "daemon")); // marker directory resolveRepoRoot looks for
  return root;
}

test("resolveRepoRoot finds a directory with presets/ and daemon/", () => {
  const root = makeFakeRepo();
  try {
    const nested = join(root, "packages", "raycast", "src", "lib");
    mkdirSync(nested, { recursive: true });
    assert.equal(resolveRepoRoot(nested), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRepoRoot finds the real ghostkeys repo root from this file's location", () => {
  const root = resolveRepoRoot(__dirname);
  // Sanity: the real repo has both of these.
  assert.match(root, /ghostkeys$/);
});

test("loadPresetLibrary falls back to built-ins when presets/library.json is absent", () => {
  const root = makeFakeRepo();
  try {
    const result = loadPresetLibrary(join(root, "packages", "raycast", "src", "lib"));
    assert.equal(result.source, "builtin");
    assert.deepEqual(result.presets, BUILTIN_PRESETS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPresetLibrary reads and validates presets/library.json when present", () => {
  const root = makeFakeRepo();
  try {
    const library = {
      presets: [
        { id: "p1", name: "Say hi", action: { kind: "text", text: "hi" } },
        { name: "No id, still valid", action: { kind: "mute" } },
        { name: "Missing action - should be dropped" },
        { id: "p2", action: { kind: "mute" } }, // missing name - should be dropped
      ],
    };
    writeFileSync(join(root, "presets", "library.json"), JSON.stringify(library));

    const result = loadPresetLibrary(join(root, "packages", "raycast", "src", "lib"));
    assert.equal(result.source, "library");
    assert.equal(result.presets.length, 2);
    assert.equal(result.presets[0].id, "p1");
    assert.equal(result.presets[1].name, "No id, still valid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadLayouts returns [] when presets/layouts is empty", () => {
  const root = makeFakeRepo();
  try {
    const layouts = loadLayouts(join(root, "packages", "raycast", "src", "lib"));
    assert.deepEqual(layouts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadLayouts reads *.json files from presets/layouts", () => {
  const root = makeFakeRepo();
  try {
    const zone: Zone = { id: "z1", name: "Zone 1", surface: "base", rect: { x: 0, y: 0, w: 1, h: 1 }, color: "#fff" };
    writeFileSync(
      join(root, "presets", "layouts", "default.json"),
      JSON.stringify({ name: "Default", zones: [zone] }),
    );
    writeFileSync(join(root, "presets", "layouts", "not-a-layout.json"), JSON.stringify({ foo: "bar" }));

    const layouts = loadLayouts(join(root, "packages", "raycast", "src", "lib"));
    assert.equal(layouts.length, 1);
    assert.equal(layouts[0].name, "Default");
    assert.equal(layouts[0].zones.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diffZones reports added, removed, changed, and unchanged zones", () => {
  const current: Zone[] = [
    { id: "a", name: "A", surface: "base", rect: { x: 0, y: 0, w: 1, h: 1 }, color: "#111" },
    { id: "b", name: "B", surface: "base", rect: { x: 0, y: 0, w: 1, h: 1 }, color: "#222" },
  ];
  const incoming: Zone[] = [
    { id: "a", name: "A", surface: "base", rect: { x: 0, y: 0, w: 1, h: 1 }, color: "#111" }, // unchanged
    { id: "b", name: "B renamed", surface: "base", rect: { x: 0, y: 0, w: 1, h: 1 }, color: "#222" }, // changed
    { id: "c", name: "C", surface: "lid", rect: { x: 0, y: 0, w: 1, h: 1 }, color: "#333" }, // added
  ];

  const diff = diffZones(current, incoming);
  assert.equal(diff.unchanged.length, 1);
  assert.equal(diff.unchanged[0].id, "a");
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].before.id, "b");
  assert.equal(diff.changed[0].after.name, "B renamed");
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].id, "c");
  assert.equal(diff.removed.length, 0);
});
