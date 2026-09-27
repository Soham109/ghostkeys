"""Repeated stratified cross-validation of zone classifiers on real calibration samples.

Metrics at a confidence threshold, over zone taps (recall, wrong zone) and typing negatives (false):
  recall = accepted with the right zone / zone taps
  wrong  = accepted with a wrong zone / zone taps
  false  = negatives accepted as any zone / negatives
Classes with fewer than 5 samples are dropped (they cannot be cross-validated).
"""
import json
import numpy as np
from zonemodel_py import ZoneModelPy, NONE


def load(path, min_n=5):
    S = json.load(open(path))
    X = np.array([s["features"]["values"] for s in S], float)
    y = np.array([s["label"] for s in S])
    keep = np.array([(y == c).sum() >= min_n for c in y])
    return X[keep], y[keep]


def folds_for(y, seed, k=5):
    rng = np.random.default_rng(seed)
    f = np.zeros(len(y), int)
    for c in sorted(set(y)):
        idx = np.where(y == c)[0]
        rng.shuffle(idx)
        f[idx] = np.arange(len(idx)) % k
    return f


def cv_predictions(make, X, y, reps=10):
    """Out-of-fold (label, confidence) for every sample, per repetition."""
    out = []
    for r in range(reps):
        f = folds_for(y, r)
        lab = np.empty(len(y), object); conf = np.zeros(len(y))
        for k in range(5):
            m = make().fit(X[f != k], y[f != k])
            l, c = m.predict(X[f == k])[:2]
            lab[f == k] = l; conf[f == k] = c
        out.append((lab, conf))
    return out


def metrics(preds, y, th):
    z = y != NONE
    rec = wr = fa = 0.0
    for lab, conf in preds:
        acc = (lab != NONE) & (conf >= th)
        rec += (acc & z & (lab == y)).sum() / z.sum()
        wr += (acc & z & (lab != y)).sum() / z.sum()
        fa += (acc & ~z).sum() / max((~z).sum(), 1)
    n = len(preds)
    return rec / n, wr / n, fa / n


if __name__ == "__main__":
    for name in ("calib1", "calib2"):
        X, y = load(f"data/{name}/samples.json")
        preds = cv_predictions(ZoneModelPy, X, y)
        print(name, {th: tuple(round(v, 3) for v in metrics(preds, y, th)) for th in (0.7, 0.8, 0.9)})
