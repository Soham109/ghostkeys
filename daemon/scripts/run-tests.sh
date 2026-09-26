#!/bin/zsh
# Runs every swift-testing suite of the daemon package on a Mac with only the Command Line Tools.
#
# `swift test` there builds swift-testing suites but silently runs none of them (exit 0, no output).
# This script mirrors each test target into its own runner package under daemon/.build-tests/,
# builds it as an executable whose entry point is Testing.__swiftPMEntryPoint(), and runs it.
# A test target whose code (or whose dependencies' code) does not compile is skipped and reported.
#
# Usage:
#   scripts/run-tests.sh                       all test targets
#   scripts/run-tests.sh Detection             only test targets whose name contains "Detection"
#   scripts/run-tests.sh Detection -- --filter burstLockout
#                                              extra arguments after -- go to swift-testing
#   scripts/run-tests.sh --strict              also exit non-zero when a target is skipped
#   scripts/run-tests.sh --release             build optimised (default: debug)
#
# Exit status: 0 if every suite that ran passed; 1 if any failed (or, with --strict, was skipped).

set -u
SCRIPT_DIR=${0:A:h}
PKG=${SCRIPT_DIR:h}
OUT=$PKG/.build-tests

filter=""
strict=0
config=debug
runner_args=()
while (( $# > 0 )); do
  case $1 in
    --strict) strict=1 ;;
    --release) config=release ;;
    -h|--help) sed -n '2,17p' $0 | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; runner_args=("$@"); break ;;
    *) filter=$1 ;;
  esac
  shift
done

if [[ -t 1 ]]; then B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'; else B=""; R=""; G=""; Y=""; N=""; fi

mkdir -p $OUT
dump=$OUT/package.json
if ! swift package --package-path $PKG dump-package > $dump 2> $OUT/dump.log; then
  print -u2 "${R}Could not read Package.swift:${N}"; cat $OUT/dump.log >&2; exit 1
fi

tests=(${(f)"$(python3 -c 'import json,sys; [print(t["name"]) for t in json.load(open(sys.argv[1]))["targets"] if t["type"]=="test"]' $dump)"})
[[ -n $filter ]] && tests=(${(M)tests:#*${filter}*})
if (( ${#tests} == 0 )); then print -u2 "No test target matches '${filter}'."; exit 1; fi

typeset -A result
failed=0 skipped=0
for t in $tests; do
  print "${B}== $t${N}"
  if ! pkgdir=$(python3 $SCRIPT_DIR/lib/make_runner_package.py $PKG $dump $t $OUT 2> $OUT/$t.gen.log); then
    result[$t]="SKIPPED: runner package could not be generated ($(tail -1 $OUT/$t.gen.log))"
    print "${Y}${result[$t]}${N}"; (( skipped++ )); continue
  fi
  [[ -s $OUT/$t.gen.log ]] && cat $OUT/$t.gen.log

  test_files=($PKG/Tests/$t/**/*.swift(N))
  if (( ${#test_files} == 0 )); then
    result[$t]="SKIPPED: no test files"
    print "${Y}${result[$t]}${N}"; (( skipped++ )); continue
  fi

  # -enable-testing on every module so tests can use @testable import.
  if ! swift build --package-path $pkgdir -c $config -Xswiftc -enable-testing > $pkgdir/build.log 2>&1; then
    result[$t]="SKIPPED: does not compile (log: ${pkgdir#$PKG/}/build.log)"
    print "${Y}${result[$t]}${N}"
    grep -E "error:" $pkgdir/build.log | sort -u | head -8 | sed 's/^/    /'
    (( skipped++ )); continue
  fi

  log=$pkgdir/test.log
  # Show failures, issues and printed output; hide the per-test "started"/"passed" chatter.
  esc=$'\e'
  quiet="^(${esc}\\[[0-9;]*m)?(◇|✔)(${esc}\\[[0-9;]*m)? (Test|Suite) .*(started|passed after)"
  $pkgdir/.build/$config/$t "${runner_args[@]}" 2>&1 | tee $log | grep -vE "$quiet" | grep -vE "Test run with"
  code=${pipestatus[1]}
  summary=$(sed $'s/\e\\[[0-9;]*m//g' $log | grep -E "Test run with" | tail -1 | sed 's/^[^A-Za-z]*//')
  [[ -z $summary ]] && summary="no summary line (runner exited with status $code)"
  [[ $summary == *"with 0 tests"* ]] && summary="$summary (no tests found)"
  result[$t]=$summary
  if (( code != 0 )); then (( failed++ )); fi
done

print "\n${B}Summary${N}"
for t in $tests; do
  case ${result[$t]} in
    SKIPPED*) c=$Y ;;
    *passed*) c=$G ;;
    *) c=$R ;;
  esac
  printf "  %-28s %s\n" $t "${c}${result[$t]}${N}"
done

if (( failed > 0 )); then exit 1; fi
if (( strict && skipped > 0 )); then exit 1; fi
exit 0
