"""Operating points from a cross-validated live-path dump (TSV from the temporary Swift harness).

tap recall = zone taps accepted with the right zone; wrong = accepted with a wrong zone;
false = typing negatives accepted as a zone. Also per-zone recall at the chosen threshold.
Usage: operating_points.py dump.tsv [threshold-for-per-zone]
"""
import sys
import numpy as np
import pandas as pd

d = pd.read_csv(sys.argv[1], sep="\t")
th_zone = float(sys.argv[2]) if len(sys.argv) > 2 else 0.8
zones = d[d.label != "none"]
neg = d[d.label == "none"]
print("threshold  tap-recall  wrong-zone  false-taps(per negative)")
for th in (0.5, 0.6, 0.7, 0.8, 0.9):
    acc = (zones.pred != "none") & (zones.conf >= th)
    rec = (acc & (zones.pred == zones.label)).mean()
    wr = (acc & (zones.pred != zones.label)).mean()
    fa = ((neg.pred != "none") & (neg.conf >= th)).mean() if len(neg) else float("nan")
    print(f"   {th:.1f}       {rec:.3f}       {wr:.3f}       {fa:.3f}")
acc = (d.pred != "none") & (d.conf >= th_zone)
print(f"per-zone recall at {th_zone}:",
      {z: round(float((acc & (g.pred == z))[g.index].mean()), 2) for z, g in zones.groupby("label")})
