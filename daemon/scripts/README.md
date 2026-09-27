# daemon/scripts

## run-tests.sh

Runs every swift-testing suite in the daemon package on a Mac that has only the Command Line Tools (no Xcode).

Why it exists: on the Command Line Tools, `swift test` builds swift-testing suites and then runs none of them. It prints nothing and exits 0, so a broken test looks like a pass.

```sh
cd daemon
scripts/run-tests.sh                                   # every test target
scripts/run-tests.sh Detection                         # test targets whose name contains "Detection"
scripts/run-tests.sh Detection -- --filter burstLockout  # arguments after -- go to swift-testing
scripts/run-tests.sh --strict                          # a skipped target also fails the run
scripts/run-tests.sh --release                         # optimised build (default is debug)
```

It ends with one line per test target, for example:

```
Summary
  GhostkeysVisionTests         Test run with 44 tests in 3 suites passed after 0.590 seconds.
  GhostkeysIntegrationsTests   SKIPPED: does not compile (log: .build-tests/GhostkeysIntegrationsTests/build.log)
  GhostkeysDetectionTests      Test run with 59 tests in 8 suites passed after 1.501 seconds.
```

Exit status:
- 0: every suite that ran passed.
- 1: a suite failed, no target matched the filter, or `--strict` was given and a target was skipped.

### How it works

1. `swift package dump-package` reads the test targets and their dependencies from `Package.swift`. This does not compile anything.
2. For each test target `T`, `lib/make_runner_package.py` writes a runner package to `daemon/.build-tests/T/`:
   - copies of the library targets `T` depends on, including indirect ones, with their `exclude`, resources and settings;
   - `T`'s test files, turned into an executable target with a generated `@main` entry point that calls `Testing.__swiftPMEntryPoint()`. That is the function `swift test` would have called.
3. The runner is built with `-enable-testing`, so `@testable import` works. Then it is run.
4. If the build fails, that target is reported as skipped and the first compile errors are shown. Other targets still run, so one half-finished module does not block the rest.

Output of each run is kept in `.build-tests/T/`: `build.log` has the compiler output and `test.log` the full test output. Runs after the first reuse the build cache. `.build-tests/` is gitignored through `.build-*/`.

### Without swift-testing: the shim runner

Swift 5.10 Command Line Tools ship no swift-testing at all (`no such module 'Testing'`). The script notices (no
`Testing.framework` in the Command Line Tools) and switches to the shim runner by itself; `--shim` forces it.
`lib/shim_tests.py` copies the test files and rewrites the few swift-testing constructs they use:

| swift-testing | shim |
| --- | --- |
| `#expect(x)`, `#expect(await x)` | `__gkExpect(x)`, `await __gkExpectAsync(await x)` |
| `#expect(throws: E.self) { }`, `#expect(throws: value) { }` | `__gkExpectThrows(...) { }` |
| `#require(x)`, `#require(await x)` | `__gkRequire(x)`, `await __gkRequireAsync(await x)` |
| `Issue.record(...)` | a shim `Issue` type |
| `@Suite`, `@Test`, `@Test(.enabled(if: c))` | a generated `@main` that calls every test (skipping disabled ones) |

Anything else (parameterized `@Test(arguments:)`, traits other than `.enabled(if:)`, other macros) makes the target
fail to generate, with a message, rather than silently skipping tests. The summary line says "shim runner". The
test sources are not changed. Checked on 2026-09-27: 243 tests over the 4 targets pass, and putting back a known
bug makes the matching test fail with exit status 1.

### Limits

- Test targets that depend on products of other packages, or on executable targets, are skipped with a message. The package has neither today.
- Build settings with platform or configuration conditions are dropped, with a note.
- Test targets must not contain a `main.swift`.
- In files that `import Testing`, use `import Darwin` instead of `import Foundation` (this matters for the
  swift-testing runner only; the shim runner does not care). Having both imports in one file needs an add-on module that the Command Line Tools cannot load. Put Foundation-dependent helpers in a separate file of the test target that does not import Testing.
