#!/bin/zsh
# Real-data benchmark for GhostkeysDetection: the gate every detection change must pass.
#
# Replays the user's real recordings and calibrations through the library exactly as the daemon uses it
# (Trainer, TapEngine, ZoneModel + minConfidence) and prints recall, wrong-zone rate, false taps and latency.
#
# Usage (from anywhere):
#   daemon/analysis/bench/run.sh                         benchmark the working tree
#   daemon/analysis/bench/run.sh --save before.json      ...and save the numbers
#   daemon/analysis/bench/run.sh --compare before.json   ...and print WIN / LOSS against saved numbers
#   daemon/analysis/bench/run.sh --src /path/to/GhostkeysDetection --label old --save old.json
#                                                        benchmark another copy of the library
#   daemon/analysis/bench/run.sh --settings '{"minConfidence":0.9}'   other DetectionSettings (JSON)
#   daemon/analysis/bench/run.sh --reps 5                cross-validation repetitions (default 10)
#
# Round 2 checks (Sources/GuardSuites.swift, docs/review/DETECTION_ROUND2.md), printed and saved like the rest:
#   upg.*                  in-session recall (per zone for calib2, the live model) of models saved by older builds,
#                          after ZoneModel.upgraded(); needs data/oldstyle-folds/ (see GuardSuites.swift)
#   guard.s1.strictAtTap   share of real lap taps that arrive while the familiarity guard is strict
#   guard.junkN.*          same for calibration taps with N typing spikes past the gates before each
#   splice.strict.*        composed grille doubles that fire with the guard forced strict
#
# Round 3 checks (Sources/PostureSuites.swift, docs/review/DETECTION_ROUND3.md):
#   posture.known.* / posture.legacy.*   desk + lap models in a ZoneModelSet, picked by gravity: which model is live
#                          at lap taps and on the desk, recall through the set, switches per minute
#   xpost.*                cross-posture recall of a single model (a lap model on desk taps)
# Research that is not a regression gate: round3/run.sh (gravity-aligned feature frame).
#
# Data (gitignored, never modified): daemon/analysis/data/. `fetch-data.sh` copies the daemon's current
# calibration and diagnostics there (read-only copies). The recordings used:
#   calib1, calib_bak, calib2   three real calibrations (26 Sep 2026, 18:21, 19:05, 23:49), features only
#   session1.gkrec              117 s lab recording, laptop on a lap, 3 zones, raw IMU
#   regress1/missed-*.gkrec     the daemon's two feedback_missed diagnostics, raw IMU
#   RestRecording.swift         12 s desk rest recording from the detection tests
#
# Builds optimised with swiftc into daemon/.build-bench/ (gitignored), niced.

set -eu
BENCH=${0:A:h}
DAEMON=${BENCH:h:h}
SRC=$DAEMON/Sources/GhostkeysDetection
OUT=$DAEMON/.build-bench
label="working tree"
passthrough=()
while (( $# > 0 )); do
  case $1 in
    --src) SRC=${2:A}; shift ;;
    --label) label=$2; shift ;;
    --save) passthrough+=(--out ${2:A}); shift ;;
    --compare) passthrough+=(--compare ${2:A}); shift ;;
    --settings|--reps) passthrough+=($1 $2); shift ;;
    -h|--help) sed -n '2,36p' $0 | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) print -u2 "unknown option $1"; exit 2 ;;
  esac
  shift
done

# Separate build folder per library source, so benchmarking an old copy does not rebuild the current one.
key=$(print -r -- $SRC | shasum | cut -c1-10)
B=$OUT/$key
mkdir -p $B
lib_sources=(${SRC}/**/*.swift)
stamp=$B/stamp
if [[ ! -f $B/bench || -n $(find $SRC $BENCH/Sources -name '*.swift' -newer $stamp 2>/dev/null | head -1) ]]; then
  print -u2 "building ($SRC)..."
  nice -n 10 swiftc -O -parse-as-library -emit-library -static -module-name GhostkeysDetection \
    -emit-module -emit-module-path $B/GhostkeysDetection.swiftmodule -o $B/libGhostkeysDetection.a $lib_sources
  # Features the library may or may not have (so older copies still build): -D flags for the bench.
  defs=()
  grep -rq "struct FamiliarityGuard" $SRC && defs+=(-D HAS_FAMILIARITY)
  grep -rq "struct ZoneModelSet" $SRC && defs+=(-D HAS_POSTURE)
  nice -n 10 swiftc -O ${defs[@]} -I $B -L $B -lGhostkeysDetection -o $B/bench $BENCH/Sources/*.swift
  touch $stamp
fi
cd $DAEMON
nice -n 10 $B/bench --data $DAEMON/analysis/data --tests $DAEMON/Tests/GhostkeysDetectionTests --label $label "${passthrough[@]}"
