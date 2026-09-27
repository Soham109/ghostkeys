#!/bin/zsh
# Round 3 research (docs/review/DETECTION_ROUND3.md): gravity-aligned feature frame vs the sensor frame, on the real
# data in daemon/analysis/data. Builds the working-tree library into daemon/.build-bench/round3/ (gitignored), niced.
#   daemon/analysis/bench/round3/run.sh     prints the table and writes results/2026-09-27-round3-frame.json
set -eu
HERE=${0:A:h}
DAEMON=${HERE:h:h:h}
OUT=$DAEMON/.build-bench/round3
mkdir -p $OUT
nice -n 10 swiftc -O -parse-as-library -emit-library -static -module-name GhostkeysDetection \
  -emit-module -emit-module-path $OUT/GhostkeysDetection.swiftmodule -o $OUT/libGhostkeysDetection.a $DAEMON/Sources/GhostkeysDetection/**/*.swift
B=$DAEMON/analysis/bench/Sources
nice -n 10 swiftc -O -D HAS_FAMILIARITY -I $OUT -L $OUT -lGhostkeysDetection -o $OUT/frame $B/Data.swift $B/Suites.swift $HERE/frame/main.swift
nice -n 10 $OUT/frame $DAEMON/analysis/data $DAEMON/Tests/GhostkeysDetectionTests $HERE/../results/2026-09-27-round3-frame.json
