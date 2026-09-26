"""How separable are the recorded zones? Leave-one-out accuracy of simple classifiers on real taps.

Two tap sets:
  truth : the onsets the lab tool recorded (its own simple detector) with the phase's zone label
  engine: every onset the Swift-equivalent onset detector finds inside a capture phase, labeled by phase,
          minus pulses whose half-peak width is over 120 ms (handling, not taps)
Run: .venv/bin/python separability.py data/session1
"""
import sys
import itertools
import numpy as np
import pandas as pd
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.neighbors import KNeighborsClassifier
from sklearn.model_selection import LeaveOneOut, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
import gk

imu, on, segs, act, h = gk.load(sys.argv[1] if len(sys.argv) > 1 else "data/session1")
a = imu[["ax", "ay", "az"]].to_numpy()
w = imu[["gx", "gy", "gz"]].to_numpy()
t = imu.t.to_numpy()
fs = gk.FS
lvl = gk.hp_level(a)


def half_peak_width(i):
    seg = lvl[i:i + int(0.3 * fs)]
    p = seg[:int(0.04 * fs)].max()
    return np.where(seg >= 0.5 * p)[0].max() / fs * 1000


def table(idx_labels):
    rows = []
    for i, z in idx_labels:
        f = gk.features(a, w, i)
        f["zone"] = z
        f["t"] = t[i]
        rows.append(f)
    return pd.DataFrame(rows)


truth = table([(int(np.searchsorted(t, r.t)), r.zone) for r in on.itertuples()])
eng = []
for d in gk.onsets_like_engine(a, t, lvl=lvl):
    for s in segs.itertuples():
        if s.start <= d["t"] <= s.end and half_peak_width(d["i"]) <= 120:
            eng.append((d["i"], s.zone))
engine = table(eng)

FEATS = [c for c in truth.columns if c not in ("zone", "t")]
ROBUST = ["dirX", "dirY", "dirZ", "tpiX", "tpiY", "tpiZ", "xHat", "yHat", "erX", "erY", "erZ",
          "b20", "b60", "b120", "b250", "ring", "decay", "gyroAccel"]


def loo(df, feats, model):
    X, y = df[feats].to_numpy(), df.zone.to_numpy()
    p = cross_val_predict(model, X, y, cv=LeaveOneOut())
    return (p == y).mean(), p


def lda():
    return make_pipeline(StandardScaler(), LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto"))


def knn():
    return make_pipeline(StandardScaler(), KNeighborsClassifier(5, weights="distance"))


for name, df in (("truth taps", truth), ("engine onsets in capture phases", engine)):
    print(f"\n== {name}: " + ", ".join(f"{z}={n}" for z, n in df.zone.value_counts().items()))
    print("per-zone medians of key features:")
    print(df.groupby("zone")[["strength", "impZ", "twX", "twY", "xHat", "yHat", "dirX", "dirY", "dirZ",
                              "b20", "b60", "b120", "ring", "decay", "gyroAccel"]].median().round(2).to_string())
    for fs_name, feats in (("all 33 features", FEATS), ("18 force-independent features", ROBUST)):
        acc3, p = loo(df, feats, lda())
        acck, _ = loo(df, feats, knn())
        print(f"  {fs_name}: 3-zone LOO accuracy LDA {acc3:.2f}, kNN {acck:.2f}")
        print("   confusion (LDA):")
        print(pd.crosstab(df.zone, p, rownames=["true"], colnames=["pred"]).to_string().replace("\n", "\n     "))
        for z1, z2 in itertools.combinations(sorted(df.zone.unique()), 2):
            sub = df[df.zone.isin([z1, z2])]
            acc, _ = loo(sub, feats, lda())
            print(f"   pair {z1} vs {z2}: LDA LOO {acc:.2f} (n={len(sub)})")

# Single-feature separation (Fisher ratio) on the engine set, to show what carries the signal.
print("\nmost separating single features (engine set, Fisher ratio between-zone / within-zone variance):")
g = engine.groupby("zone")[FEATS]
between = g.mean().var()
within = g.var().mean()
print((between / within).sort_values(ascending=False).head(10).round(2).to_string())
