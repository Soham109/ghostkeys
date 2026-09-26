import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This package is ESM ("type": "module"), so there's no CJS __dirname
// global. Derive the equivalent from import.meta.url instead; esbuild (what
// `ray build` uses) knows how to transform `import.meta.url` for whatever
// output format it bundles to.
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Finds the ghostkeys repo root so we can read `presets/library.json` and
 * `presets/layouts/*` straight out of the monorepo, as asked for
 * ("search ../../presets/library.json if present" relative to
 * packages/raycast).
 *
 * We deliberately don't hardcode "../../.." from `__dirname`, because that
 * relationship only holds when this file runs straight out of `src/`.
 * `ray build` bundles each command into a single file directly under
 * `dist/`, which changes the directory depth. Instead we walk upward from
 * wherever this module actually loaded from and stop at the first ancestor
 * that looks like the ghostkeys repo root (has both `presets/` and
 * `daemon/`, per the repo layout documented in docs/PROTOCOL.md). This works
 * the same whether the code is running via tsx in tests, via `ray develop`,
 * or from a bundled `ray build` output.
 *
 * Set GHOSTKEYS_REPO_ROOT to override (used by the test suite).
 */
export function resolveRepoRoot(startDir: string = moduleDir): string {
  const override = process.env.GHOSTKEYS_REPO_ROOT;
  if (override) return override;

  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "presets")) && existsSync(join(dir, "daemon"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the known package depth (packages/raycast -> repo root).
  return join(startDir, "..", "..", "..");
}

export function presetsLibraryPath(startDir?: string): string {
  return join(resolveRepoRoot(startDir), "presets", "library.json");
}

export function layoutsDirPath(startDir?: string): string {
  return join(resolveRepoRoot(startDir), "presets", "layouts");
}

export function readJsonIfExists<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
