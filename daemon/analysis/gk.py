"""Shared helpers for analysing Ghostkeys lab recordings (exported with `ghostkeys-lab export --csv`).

Mirrors the Swift detection code closely enough to reason about it: the same 15 Hz one-pole high-pass
detection level, the same 50 ms gravity low-pass, the same feature definitions (see
Sources/GhostkeysDetection/Features/FeatureExtractor.swift).
"""
import json
import os
import numpy as np
import pandas as pd

FS = 796.4


def load(export_dir):
    imu = pd.read_csv(os.path.join(export_dir, "imu.csv"))
    onsets = pd.read_csv(os.path.join(export_dir, "onsets.csv"))
    segs = pd.read_csv(os.path.join(export_dir, "segments.csv"))
    act = pd.read_csv(os.path.join(export_dir, "activity.csv"))
    with open(os.path.join(export_dir, "header.json")) as f:
        header = json.load(f)
    return imu, onsets, segs, act, header


def one_pole_lowpass(x, alpha):
    """y[n] = y[n-1] + alpha (x[n] - y[n-1]) along axis 0, initialised at x[0]."""
    y = np.empty_like(x)
    acc = x[0].copy()
    for i in range(len(x)):
        acc += alpha * (x[i] - acc)
        y[i] = acc
    return y


def hp_level(a, fs=FS, fc=15.0):
    """Detection level: magnitude of the 15 Hz high-passed accel vector (g)."""
    alpha = 1 - np.exp(-2 * np.pi * fc / fs)
    return np.linalg.norm(a - one_pole_lowpass(a, alpha), axis=1)


def gravity(a, fs=FS, tau=0.05):
    return one_pole_lowpass(a, 1 - np.exp(-1 / (tau * fs)))


def angle_deg(u, v):
    u = u / np.linalg.norm(u, axis=-1, keepdims=True)
    v = v / np.linalg.norm(v, axis=-1, keepdims=True)
    return np.degrees(np.arccos(np.clip((u * v).sum(-1), -1, 1)))


def rolling_rotation(g, fs=FS, window=0.5):
    """For each sample: largest angle between gravity now and any gravity in the previous `window` s
    (evaluated on a 10 ms grid, like GravityMonitor)."""
    step = 8
    idx = np.arange(0, len(g), step)
    gd = g[idx]
    k = int(round(window * fs / step))
    out = np.zeros(len(idx))
    for j in range(len(idx)):
        lo = max(0, j - k)
        out[j] = angle_deg(gd[j][None, :], gd[lo:j + 1]).max()
    return idx, out


BANDS = [(20, 60), (60, 120), (120, 250), (250, 400.1)]


def features(a, w, o, fs=FS):
    """Numeric features around onset index o, same definitions as FeatureExtractor.swift."""
    pre, post, base_n = round(0.02 * fs), round(0.08 * fs), round(0.1 * fs)
    imp_n, tw_n = round(0.015 * fs), round(0.03 * fs)
    ws, we = o - pre, o + post
    ab = a[ws - base_n:ws].mean(0)
    gb = w[ws - base_n:ws].mean(0)
    d = a[ws:we] - ab
    g = w[ws:we] - gb
    s = pre - 3
    dt = 1000 / fs
    imp = d[s:s + imp_n].sum(0) * dt
    tw = g[s:s + tw_n].sum(0) * dt
    peak_idx = np.abs(d).argmax(0)
    peak_a = d[peak_idx, [0, 1, 2]] * 1000
    peak_g = g[np.abs(g).argmax(0), [0, 1, 2]]
    ea = (d[s:] ** 2).sum(0)
    eg = (g[s:] ** 2).sum()
    az = imp[2] if abs(imp[2]) >= 0.05 else np.copysign(0.05, imp[2])
    x_hat = np.clip(tw[1] / az, -2000, 2000)
    y_hat = np.clip(-tw[0] / az, -2000, 2000)
    seg = d[s:s + 64]
    spec = (np.abs(np.fft.rfft(seg, n=64, axis=0)) ** 2).sum(1)
    freqs = np.fft.rfftfreq(64, 1 / fs)
    bands = np.array([spec[(freqs >= lo) & (freqs < hi)].sum() for lo, hi in BANDS])
    bands = bands / max(bands.sum(), 1e-18)
    ring = freqs[2 + spec[2:].argmax()]
    env = np.linalg.norm(d, axis=1)
    pk = env.argmax()
    above = np.where(env[pk:] >= 0.25 * env[pk])[0]
    decay = above.max() * dt
    impl = max(np.linalg.norm(imp), 1e-6)
    return dict(
        impX=imp[0], impY=imp[1], impZ=imp[2],
        peakAX=peak_a[0], peakAY=peak_a[1], peakAZ=peak_a[2],
        twX=tw[0], twY=tw[1], twZ=tw[2],
        peakGX=peak_g[0], peakGY=peak_g[1], peakGZ=peak_g[2],
        xHat=x_hat, yHat=y_hat,
        erX=ea[0] / ea.sum(), erY=ea[1] / ea.sum(), erZ=ea[2] / ea.sum(),
        gyroAccel=np.log10((eg + 0.01) / (ea.sum() + 1e-6)),
        b20=bands[0], b60=bands[1], b120=bands[2], b250=bands[3],
        ring=ring, decay=decay, strength=np.log10(env[pk] * 1000),
        dirX=imp[0] / impl, dirY=imp[1] / impl, dirZ=imp[2] / impl,
        tpiX=tw[0] / impl, tpiY=tw[1] / impl, tpiZ=tw[2] / impl,
    )


def onsets_like_engine(a, t, fs=FS, sensitivity=0.5, refractory=0.06, quiet=0.015, max_pulse=0.12,
                       settle=0.4, lvl=None):
    """Python mirror of OnsetDetector.swift (without burst lockout). Returns a list of dicts:
    t, i, thr, noise, peak, width (s; half-peak width) or None if the pulse was too long."""
    if lvl is None:
        lvl = hp_level(a, fs)
    k = 9 - 6 * sensitivity
    floor = (30 - 25 * sensitivity) / 1000
    blocks, block, noise = [], [], 0.0
    out, state, last_onset, tail_until = [], "idle", -1e9, -1e9
    cur = None
    for i in range(len(lvl)):
        m = lvl[i]
        block.append(m)
        if len(block) == 40:
            blocks.append(sorted(block)[20]); block = []
            blocks = blocks[-40:]
            noise = min(float(np.median(blocks)), float(np.median(blocks[-10:])))
        ti = t[i]
        if state in ("active", "overlong"):
            if m > cur["peak"]:
                cur["peak"] = m
            if m >= 0.5 * cur["peak"]:
                cur["half"] = ti
            if m > max(cur["hyst"], 0.3 * cur["peak"]):
                cur["last"] = ti
            width = cur["half"] - cur["t"] + 1 / fs
            if ti - cur["last"] >= quiet:
                if state == "active":
                    cur["width"] = width if width <= max_pulse else None
                    out.append(cur)
                state = "idle"
                tail_until = cur["last"] + 0.3
            elif state == "active" and (width > max_pulse or ti - cur["t"] > settle):
                cur["width"] = None; out.append(cur); state = "overlong"
            continue
        if len(blocks) < 5:
            continue
        thr = max(floor, k * noise)
        if m > thr and ti - last_onset >= refractory:
            if ti < tail_until and m <= 2 * lvl[max(0, i - 20):i].max():
                continue
            last_onset = ti
            cur = dict(t=ti, i=i, thr=thr, noise=noise, hyst=0.5 * thr, last=ti, half=ti, peak=m)
            state = "active"
    return out
