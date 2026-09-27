"""Python port of the Swift ZoneModel (Classifier/ZoneModel.swift) for fast experiments.

Faithful to the Swift logic: standardization by pooled within-zone std (floored at 10% of global std),
shrunk pooled within-zone covariance (lambda = p / (p + dof), clamped 0.1..0.95), whitening, distance-
weighted 5-NN over all samples (incl. none), Gaussian posterior over zones, 50/50 combination where the
Gaussian part shares the mass k-NN did not give to none, reject distance learned out-of-fold
(max(1.3 q95, 1.1 max)), confidence softened in the outer 20% of the accepted region.
"""
import numpy as np

NONE = "none"


class Geometry:
    def __init__(self, X, y, classes):
        self.classes = classes
        zmask = y != NONE
        p = X.shape[1]
        self.mean = X.mean(0)
        gstd = X.std(0, ddof=1) if len(X) > 1 else np.ones(p)
        zones = [c for c in classes if c != NONE and (y == c).any()]
        raw_means = {c: X[y == c].mean(0) for c in classes if (y == c).any()}
        dof = zmask.sum() - len(zones)
        pooled = np.zeros(p)
        for c in zones:
            pooled += ((X[y == c] - raw_means[c]) ** 2).sum(0)
        within = np.sqrt(pooled / dof) if dof > 0 else gstd
        scale = np.maximum(np.maximum(within, 0.1 * gstd), 1e-9)
        scale[gstd < 1e-12] = 1
        self.scale = scale
        Z = (X - self.mean) / scale
        zm = {c: (raw_means[c] - self.mean) / scale for c in raw_means}
        cov = np.zeros((p, p))
        for c in zones:
            D = Z[y == c] - zm[c]
            cov += D.T @ D
        lam = np.clip(p / (p + max(dof, 0)), 0.1, 0.95)
        cov = cov / dof if dof > 0 else np.eye(p)
        cov = (1 - lam) * cov + lam * np.eye(p)
        self.L = np.linalg.cholesky(cov + 1e-9 * np.eye(p))
        self.class_means = {c: self.whiten_z(zm[c]) for c in zones}

    def whiten_z(self, z):
        return np.linalg.solve(self.L, z.T).T

    def whiten(self, X):
        return self.whiten_z((X - self.mean) / self.scale)


class ZoneModelPy:
    def __init__(self, k=5, folds=5):
        self.k, self.folds = k, folds

    def fit(self, X, y):
        zones = sorted(set(y) - {NONE})
        self.classes = zones + ([NONE] if (y == NONE).any() else [])
        self.geo = Geometry(X, y, self.classes)
        self.W = self.geo.whiten(X)
        self.y = y
        # Out-of-fold reject distance.
        spread = []
        zidx = np.where(y != NONE)[0]
        if len(zidx) >= 2 * self.folds:
            fold = np.zeros(len(y), int)
            rank = {}
            for i in zidx:
                fold[i] = rank.get(y[i], 0) % self.folds
                rank[y[i]] = rank.get(y[i], 0) + 1
            for f in range(self.folds):
                tr = (y == NONE) | (fold != f)
                g = Geometry(X[tr], y[tr], self.classes)
                for i in zidx[fold[zidx] == f]:
                    if y[i] in g.class_means:
                        spread.append(np.linalg.norm(g.whiten(X[i:i + 1])[0] - g.class_means[y[i]]))
        self.reject = max(1.3 * np.quantile(spread, 0.95), 1.1 * max(spread)) if len(spread) >= 5 else np.inf
        return self

    def predict(self, X):
        """Returns (label, confidence, probability matrix over self.classes, nearest-zone distance)."""
        W = self.geo.whiten(X)
        out_lab, out_conf, P = [], [], []
        dists = []
        cls = self.classes
        zones = [c for c in cls if c != NONE]
        for w in W:
            d = {c: np.linalg.norm(w - self.geo.class_means[c]) for c in zones if c in self.geo.class_means}
            best = min(d, key=d.get)
            d0 = d[best]
            pg = {c: np.exp(-0.5 * (d[c] ** 2 - d0 ** 2)) for c in d}
            sg = sum(pg.values())
            pg = {c: v / sg for c, v in pg.items()}
            dd = np.linalg.norm(self.W - w, axis=1)
            nn = np.argsort(dd)[: self.k]
            pk = {c: 0.0 for c in cls}
            ws = 0
            for i in nn:
                wt = 1 / (dd[i] + 1e-3)
                pk[self.y[i]] += wt
                ws += wt
            pk = {c: v / ws for c, v in pk.items()}
            pnone = pk.get(NONE, 0)
            p = {c: (pnone if c == NONE else 0.5 * pk[c] + 0.5 * (1 - pnone) * pg.get(c, 0)) for c in cls}
            top = max(p, key=p.get)
            P.append([p[c] for c in cls])
            dists.append(d0)
            if top == NONE:
                out_lab.append(NONE); out_conf.append(p[top]); continue
            dt = d[top]
            if dt > self.reject:
                out_lab.append(NONE); out_conf.append(0.0); continue
            conf = p[top]
            if np.isfinite(self.reject):
                edge = 0.8 * self.reject
                if dt > edge:
                    conf *= 1 - 0.5 * (dt - edge) / (self.reject - edge)
            out_lab.append(top); out_conf.append(min(max(conf, 0), 1))
        return np.array(out_lab), np.array(out_conf), np.array(P), np.array(dists)
