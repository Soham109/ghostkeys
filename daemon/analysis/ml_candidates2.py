import numpy as np
import ml_eval as E
from ml_candidates import Blend, Platt, report
from zonemodel_py import NONE

X1, y1 = E.load("data/calib1/samples.json")
X2, y2 = E.load("data/calib2/samples.json")
for name, X, y in (("calib1", X1, y1), ("calib2", X2, y2)):
    print(f"== {name}")
    report("current", __import__("zonemodel_py").ZoneModelPy, X, y)
    for w in (0.5, 0.7, 1.0):
        for C in (0.1, 0.3, 1.0):
            report(f"blend w={w} C={C}", lambda w=w, C=C: Blend(w, C), X, y)
    report("blend w=0.5 C=0.3 + Platt", lambda: Platt(lambda: Blend(0.5, 0.3)), X, y)
