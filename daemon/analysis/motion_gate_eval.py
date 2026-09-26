"""Compares motion-gate variants on a lab recording.

For each variant: how many recorded taps it would gate (bad), and how much of the repositioning
period between phases it flags as moving (good). Run: .venv/bin/python motion_gate_eval.py data/session1
"""
import sys
import numpy as np
import gk

imu, on, segs, act, h = gk.load(sys.argv[1] if len(sys.argv) > 1 else "data/session1")
a = imu[["ax", "ay", "az"]].to_numpy()
t = imu.t.to_numpy()
fs = gk.FS
lvl = gk.hp_level(a)
det = gk.onsets_like_engine(a, t, lvl=lvl)
onset_idx = np.array([d["i"] for d in det])
truth = on.t.to_numpy()
# Repositioning: between the end of left-palm capture and the first right-palm tap the user moved the machine.
moving_span = (28.0, 47.5)


def simulate(tau, window, thresh, persist, freeze, use_endpoint):
    alpha = 1 - np.exp(-1 / (tau * fs))
    frozen = np.zeros(len(a), bool)
    if freeze:
        for i in onset_idx:
            frozen[max(0, i - int(0.02 * fs)):i + int(freeze * fs)] = True
    g = a[0].copy()
    step = 8
    k = int(round(window * fs / step))
    hist = []
    flag_since = None
    moving = np.zeros(len(a) // step + 1, bool)
    ticks = []
    for i in range(len(a)):
        if not frozen[i]:
            g += alpha * (a[i] - g)
        if i % step:
            continue
        u = g / np.linalg.norm(g)
        hist.append(u)
        j = len(hist) - 1
        if use_endpoint:
            ang = gk.angle_deg(u, hist[max(0, j - k)])
        else:
            ang = gk.angle_deg(u[None], np.array(hist[max(0, j - k):])).max()
        tt = t[i]
        if ang > thresh:
            flag_since = tt if flag_since is None else flag_since
        else:
            flag_since = None
        moving[j] = flag_since is not None and tt - flag_since >= persist
        ticks.append(tt)
    ticks = np.array(ticks)
    moving = moving[:len(ticks)]
    # A tap is gated if the state was "moving" at its onset (the tick just before it).
    gated = [moving[max(0, np.searchsorted(ticks, x) - 1)] for x in truth]
    span = (ticks > moving_span[0]) & (ticks < moving_span[1])
    quiet = (ticks > 99) & (ticks < 108.3)
    return np.mean(gated), moving[span].mean(), moving[quiet].mean(), int(np.sum(gated))


variants = [
    ("current: 50ms LPF, max over 0.5s, >3deg", dict(tau=0.05, window=0.5, thresh=3, persist=0, freeze=0, use_endpoint=False)),
    ("200ms LPF, max over 0.5s, >3deg", dict(tau=0.2, window=0.5, thresh=3, persist=0, freeze=0, use_endpoint=False)),
    ("50ms LPF, freeze 150ms after onset, >3deg", dict(tau=0.05, window=0.5, thresh=3, persist=0, freeze=0.15, use_endpoint=False)),
    ("50ms LPF, persist 300ms, >3deg", dict(tau=0.05, window=0.5, thresh=3, persist=0.3, freeze=0, use_endpoint=False)),
    ("50ms LPF, freeze 150ms + persist 300ms, >3deg", dict(tau=0.05, window=0.5, thresh=3, persist=0.3, freeze=0.15, use_endpoint=False)),
    ("200ms LPF, freeze 150ms after onset, >3deg", dict(tau=0.2, window=0.5, thresh=3, persist=0, freeze=0.15, use_endpoint=False)),
    ("200ms LPF, freeze 150ms + persist 150ms, >3deg", dict(tau=0.2, window=0.5, thresh=3, persist=0.15, freeze=0.15, use_endpoint=False)),
    ("100ms LPF, freeze 150ms, >3deg", dict(tau=0.1, window=0.5, thresh=3, persist=0, freeze=0.15, use_endpoint=False)),
    ("200ms LPF, freeze 250ms + persist 300ms, >3deg", dict(tau=0.2, window=0.5, thresh=3, persist=0.3, freeze=0.25, use_endpoint=False)),
    ("200ms LPF, freeze 250ms + persist 300ms, >5deg", dict(tau=0.2, window=0.5, thresh=5, persist=0.3, freeze=0.25, use_endpoint=False)),
    ("200ms LPF, freeze 250ms, endpoint 0.5s, persist 300ms, >3deg", dict(tau=0.2, window=0.5, thresh=3, persist=0.3, freeze=0.25, use_endpoint=True)),
    ("200ms LPF, freeze 250ms, endpoint 0.5s, persist 300ms, >5deg", dict(tau=0.2, window=0.5, thresh=5, persist=0.3, freeze=0.25, use_endpoint=True)),
]
print(f"{'variant':62s} taps gated   moving flagged: repositioning  quiet grille")
for name, kw in variants:
    g, span, quiet, n = simulate(**kw)
    print(f"{name:62s} {n:3d}/{len(truth)} ({g:4.0%})        {span:5.0%}          {quiet:5.0%}")
