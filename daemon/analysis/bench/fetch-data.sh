#!/bin/zsh
# Copies the daemon's current calibration and diagnostics into daemon/analysis/data/ for the benchmark.
# Read-only on the daemon's folder: it only copies, and never overwrites an existing copy.
#
#   fetch-data.sh              copy the current calibration as data/calib-<date> (if new) and any diagnostics
#
# The benchmark itself reads calib1, calib_bak, calib2 and session1.gkrec; add new sets to the list in
# Sources/main.swift once they are copied.

set -eu
BENCH=${0:A:h}
DATA=${BENCH:h}/data
SRC="$HOME/Library/Application Support/Ghostkeys/daemon"
mkdir -p $DATA/diagnostics
if [[ -f "$SRC/model/samples.json" ]]; then
  stamp=$(date -r "$SRC/model/samples.json" +%Y%m%d-%H%M)
  dest=$DATA/calib-$stamp
  if [[ ! -d $dest ]]; then
    mkdir -p $dest
    for f in samples.json zone-model.json calibration-report.json; do
      [[ -f "$SRC/model/$f" ]] && cp -n "$SRC/model/$f" $dest/
    done
    print "copied calibration to $dest"
  else
    print "calibration already copied: $dest"
  fi
fi
if [[ -d "$SRC/diagnostics" ]]; then
  for f in "$SRC"/diagnostics/*.gkrec(N); do cp -n "$f" $DATA/diagnostics/; done
  print "diagnostics: $(ls $DATA/diagnostics | wc -l | tr -d ' ') file(s) in $DATA/diagnostics"
fi
[[ -f ${BENCH:h:h:h}/session1.gkrec && ! -f $DATA/session1.gkrec ]] && cp -n ${BENCH:h:h:h}/session1.gkrec $DATA/ || true
