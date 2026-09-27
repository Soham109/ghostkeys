"""Idea (b): gradient-boosted stumps as a third ensemble member (screened in Python)."""
import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from zonemodel_py import ZoneModelPy, NONE
from ml_candidates import Platt, Blend, report
import ml_eval as E


class Blend3(Blend):
    def fit(self, X, y):
        super().fit(X, y)
        self.gb = GradientBoostingClassifier(n_estimators=100, max_depth=1, learning_rate=0.1, subsample=0.8, random_state=0).fit(X, y)
        return self
    def predict(self, X):
        lab0, conf0, P0, d = self.zm.predict(X)
        cls = self.zm.classes
        Pl = self.lr.predict_proba(self.sc.transform(X))[:, [list(self.lr.classes_).index(c) for c in cls]]
        Pg = self.gb.predict_proba(X)[:, [list(self.gb.classes_).index(c) for c in cls]]
        P = (P0 + Pl + Pg) / 3
        lab = np.array([cls[i] for i in P.argmax(1)]); conf = P.max(1)
        lab[d > self.zm.reject] = NONE
        return lab, conf


for name in ("calib1", "calib2"):
    X, y = E.load(f"data/{name}/samples.json")
    print("==", name)
    report("current + logistic, Platt (shipped)", lambda: Platt(lambda: Blend(0.5, 0.3)), X, y)
    report("current + logistic + boosted stumps, Platt", lambda: Platt(lambda: Blend3(0.5, 0.3)), X, y)
