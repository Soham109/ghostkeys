"""Session1 (raw lab recording): current model vs blend+Platt, and extra shape features (idea a).
Taps = the lab tool's recorded onsets (61, 3 zones, no negatives), features computed by gk.features."""
import numpy as np
import gk, ml_eval as E
from zonemodel_py import ZoneModelPy
from ml_candidates import Blend, Platt

imu, on, segs, act, h = gk.load("data/session1")
a = imu[["ax", "ay", "az"]].to_numpy(); w = imu[["gx", "gy", "gz"]].to_numpy(); t = imu.t.to_numpy()
idx = [int(np.searchsorted(t, x)) for x in on.t]
X = np.array([list(gk.features(a, w, i).values()) for i in idx]); y = on.zone.to_numpy()


def extra(i):
    """Idea (a): early-window shape (first 12 samples per axis / peak) + spectral centroid and 85% rolloff per axis."""
    base = a[i - 96:i - 16].mean(0)
    d = a[i - 3:i + 61] - base
    pk = np.abs(d).max() + 1e-9
    shape = (d[:12] / pk).T.ravel()
    spec = np.abs(np.fft.rfft(d, axis=0)) ** 2
    f = np.fft.rfftfreq(64, 1 / gk.FS)
    cen = (spec * f[:, None]).sum(0) / (spec.sum(0) + 1e-18)
    cum = np.cumsum(spec, 0) / (spec.sum(0) + 1e-18)
    roll = np.array([f[np.searchsorted(cum[:, k], 0.85)] for k in range(3)])
    return np.concatenate([shape, cen, roll])


Xx = np.hstack([X, np.array([extra(i) for i in idx])])


def run(name, make, X):
    preds = E.cv_predictions(make, X, y)
    r = {th: E.metrics(preds, y, th)[:2] for th in (0.7, 0.8, 0.9)}
    print(f"  {name:45s} " + "  ".join(f"@{th}: recall {a_:.3f} wrong {b:.3f}" for th, (a_, b) in r.items()))


print("session1, 61 recorded taps, 3 zones (no negatives in this recording)")
run("current, 33 features", ZoneModelPy, X)
run("blend+Platt, 33 features", lambda: Platt(lambda: Blend(0.5, 0.3)), X)
run("current, 33 + 42 shape/spectral features", ZoneModelPy, Xx)
run("blend+Platt, 33 + 42 shape/spectral features", lambda: Platt(lambda: Blend(0.5, 0.3)), Xx)
