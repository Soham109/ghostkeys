"""Compares classifier designs on real calibration samples (samples.json from the daemon).

Metrics per design, 10 x repeated stratified 5-fold CV, at several confidence thresholds:
  tap recall  : zone taps accepted with the right zone / zone taps
  wrong zone  : zone taps accepted with a wrong zone / zone taps
  false taps  : typing negatives ("none") accepted as any zone / negatives
Run: .venv/bin/python classifier_sweep.py data/calib1/samples.json
"""
import json
import sys
import numpy as np
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

path = sys.argv[1] if len(sys.argv) > 1 else "data/calib1/samples.json"
S = json.load(open(path))
X = np.array([s["features"]["values"] for s in S])
y = np.array([s["label"] for s in S])
names = [
    "impX", "impY", "impZ", "pkAX", "pkAY", "pkAZ", "twX", "twY", "twZ", "pkGX", "pkGY", "pkGZ", "xHat", "yHat",
    "erX", "erY", "erZ", "gyroAccel", "b20", "b60", "b120", "b250", "ring", "decay", "rise", "width", "strength",
    "dirX", "dirY", "dirZ", "tpiX", "tpiY", "tpiZ"]


def lda():
    return make_pipeline(StandardScaler(), LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto"))


def knn():
    return make_pipeline(StandardScaler(), KNeighborsClassifier(5, weights="distance"))


def logreg(c=1.0, balanced=True):
    return make_pipeline(StandardScaler(), LogisticRegression(C=c, max_iter=5000,
                                                              class_weight="balanced" if balanced else None))


class Blend:
    """Average of predict_proba of several models (same class order)."""
    def __init__(self, *makers): self.makers = makers
    def fit(self, X, y):
        self.ms = [m().fit(X, y) for m in self.makers]; self.classes_ = self.ms[0].classes_; return self
    def predict_proba(self, X): return np.mean([m.predict_proba(X) for m in self.ms], axis=0)


def evaluate(make, feats=None, reps=10, thresholds=(0.5, 0.6, 0.7, 0.8, 0.9)):
    Xs = X if feats is None else X[:, feats]
    res = {th: np.zeros(3) for th in thresholds}
    nz = (y != "none").sum() * reps
    nn = (y == "none").sum() * reps
    for r in range(reps):
        for tr, te in StratifiedKFold(5, shuffle=True, random_state=r).split(Xs, y):
            m = make().fit(Xs[tr], y[tr])
            P = m.predict_proba(Xs[te])
            pred = m.classes_[P.argmax(1)]
            conf = P.max(1)
            for th in thresholds:
                acc = (pred != "none") & (conf >= th)
                res[th] += [np.sum(acc & (pred == y[te]) & (y[te] != "none")),
                            np.sum(acc & (pred != y[te]) & (y[te] != "none")),
                            np.sum(acc & (y[te] == "none"))]
    return {th: (v[0] / nz, v[1] / nz, v[2] / nn) for th, v in res.items()}


if __name__ == "__main__":
    no_bands = [i for i, n in enumerate(names) if n not in ("b20", "b60", "b120", "b250", "ring")]
    designs = [
        ("kNN k=5", knn, None),
        ("shrinkage LDA (none = a class)", lda, None),
        ("logistic regression, balanced", logreg, None),
        ("logistic regression, unbalanced", lambda: logreg(balanced=False), None),
        ("LDA + logistic blend", lambda: Blend(lda, logreg), None),
        ("LDA + kNN blend", lambda: Blend(lda, knn), None),
        ("LDA, no spectral features", lda, no_bands),
        ("logistic, no spectral features", logreg, no_bands),
    ]
    print(f"{'design':36s} " + "  ".join(f"th={th}: recall/wrong/false" for th in (0.5, 0.7, 0.8, 0.9)))
    for name, make, feats in designs:
        r = evaluate(make, feats)
        print(f"{name:36s} " + "  ".join(f"      {r[th][0]:.2f}/{r[th][1]:.2f}/{r[th][2]:.2f}    " for th in (0.5, 0.7, 0.8, 0.9)))
