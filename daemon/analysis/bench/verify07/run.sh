#!/bin/zsh
# Reproduces the extra measurements in docs/review/VERIFY_07_DETECTION.md.
# Builds the working-tree library and the library as it was before the 27 Sep detection commit (f9645cd, read with
# git archive; nothing in the repo changes), then runs the two programs on daemon/analysis/data.
#   daemon/analysis/bench/verify07/run.sh
set -eu
HERE=${0:A:h}
DAEMON=${HERE:h:h:h}
OUT=$DAEMON/.build-bench/verify07
mkdir -p $OUT/prev-src $OUT/lib-head $OUT/lib-prev $OUT/dump
git -C $DAEMON archive f9645cd Sources/GhostkeysDetection | tar -x -C $OUT/prev-src
build_lib() {  # $1 source dir, $2 output dir
  nice -n 10 swiftc -O -parse-as-library -emit-library -static -module-name GhostkeysDetection \
    -emit-module -emit-module-path $2/GhostkeysDetection.swiftmodule -o $2/libGhostkeysDetection.a $1/**/*.swift
}
build_lib $DAEMON/Sources/GhostkeysDetection $OUT/lib-head
build_lib $OUT/prev-src/Sources/GhostkeysDetection $OUT/lib-prev
B=$DAEMON/analysis/bench/Sources
nice -n 10 swiftc -O -I $OUT/lib-prev -L $OUT/lib-prev -lGhostkeysDetection -o $OUT/perzone-prev $B/Data.swift $B/Suites.swift $HERE/perzone/main.swift
nice -n 10 swiftc -O -D HAS_FAMILIARITY -I $OUT/lib-head -L $OUT/lib-head -lGhostkeysDetection -o $OUT/perzone-head $B/Data.swift $B/Suites.swift $HERE/perzone/main.swift
nice -n 10 swiftc -O -D HAS_FAMILIARITY -I $OUT/lib-head -L $OUT/lib-head -lGhostkeysDetection -o $OUT/guard-head $B/Data.swift $B/Suites.swift $HERE/guard/main.swift
D=$DAEMON/analysis/data T=$DAEMON/Tests/GhostkeysDetectionTests
print "#### before (f9645cd)"; nice -n 10 $OUT/perzone-prev $D $T $OUT/dump   # also writes old-style fold models to dump/
print "\n#### after (working tree)"; nice -n 10 $OUT/perzone-head $D $T $OUT/dump
print "\n#### guard and edge cases (working tree)"; nice -n 10 $OUT/guard-head $D $T
