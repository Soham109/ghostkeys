"""Candidate classifiers, screened on identical repeated folds against the current model (port)."""
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from zonemodel_py import ZoneModelPy, NONE
import ml_eval as E


class Blend:
    """Current model probabilities averaged with a multinomial logistic regression."""
    def __init__(self, w=0.5, C=0.3): self.w, self.C = w, C
    def fit(self, X, y):
        self.zm = ZoneModelPy().fit(X, y)
        self.sc = StandardScaler().fit(X)
        self.lr = LogisticRegression(C=self.C, max_iter=5000).fit(self.sc.transform(X), y)
        return self
    def predict(self, X):
        lab0, conf0, P0, d = self.zm.predict(X)
        cls = self.zm.classes
        Pl = self.lr.predict_proba(self.sc.transform(X))
        idx = [list(self.lr.classes_).index(c) for c in cls]
        P = (1 - self.w) * P0 + self.w * Pl[:, idx]
        top = P.argmax(1)
        lab = np.array([cls[i] for i in top]); conf = P.max(1)
        rej = d > self.zm.reject                     # keep the reject option
        lab[rej] = NONE
        return lab, conf


class Platt:
    """Current model + Platt scaling of its confidence, fitted on inner out-of-fold predictions:
    P(correct zone | raw confidence), with negatives counting as incorrect."""
    def __init__(self, base=ZoneModelPy): self.base = base
    def fit(self, X, y):
        f = E.folds_for(y, 123)
        raw, ok = [], []
        for k in range(5):
            m = self.base().fit(X[f != k], y[f != k])
            lab, conf = m.predict(X[f == k])[:2]
            for l, c, t in zip(lab, conf, y[f == k]):
                if l != NONE:
                    raw.append(np.log(max(c, 1e-4) / max(1 - c, 1e-4))); ok.append(int(l == t))
        self.cal = LogisticRegression(C=10).fit(np.array(raw)[:, None], ok) if len(set(ok)) == 2 else None
        self.m = self.base().fit(X, y)
        return self
    def predict(self, X):
        lab, conf = self.m.predict(X)[:2]
        if self.cal is not None:
            z = np.log(np.clip(conf, 1e-4, 1) / np.clip(1 - conf, 1e-4, 1))
            conf = self.cal.predict_proba(z[:, None])[:, 1]
        return lab, conf


def report(name, make, X, y, extra_neg=None):
    preds = []
    for r in range(10):
        f = E.folds_for(y, r)
        lab = np.empty(len(y), object); conf = np.zeros(len(y))
        for k in range(5):
            Xt, yt = X[f != k], y[f != k]
            if extra_neg is not None:
                Xt = np.vstack([Xt, extra_neg]); yt = np.concatenate([yt, [NONE] * len(extra_neg)])
            m = make().fit(Xt, yt)
            l, c = m.predict(X[f == k])[:2]
            lab[f == k] = l; conf[f == k] = c
        preds.append((lab, conf))
    row = {th: E.metrics(preds, y, th) for th in (0.6, 0.7, 0.8, 0.9)}
    print(f"  {name:40s} " + "  ".join(f"@{th}: {r:.3f}/{w:.3f}/{fa:.3f}" for th, (r, w, fa) in row.items()))
    return preds


if __name__ == "__main__":
    X1, y1 = E.load("data/calib1/samples.json")
    X2, y2 = E.load("data/calib2/samples.json")
    neg1 = X1[y1 == NONE]; neg2 = X2[y2 == NONE]
    for name, X, y, bank in (("calib1", X1, y1, neg2), ("calib2", X2, y2, neg1)):
        print(f"== {name}  (recall / wrong-zone / false-tap at each threshold)")
        report("current", ZoneModelPy, X, y)
        report("current + Platt calibration", Platt, X, y)
        report("blend with logistic (w=0.5)", lambda: Blend(0.5), X, y)
        report("blend with logistic (w=0.3)", lambda: Blend(0.3), X, y)
        report("current + negative bank (other calib)", ZoneModelPy, X, y, extra_neg=bank)
        report("blend w=0.5 + negative bank", lambda: Blend(0.5), X, y, extra_neg=bank)
