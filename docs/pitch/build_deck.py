from lib2 import *

# Six slides. One idea each, very few words, one gentle entrance per slide at most.

# 1 ---------------------------------------------------------------- title
s = new_slide()
bgp = picture(s, os.path.join(IMG, "intro-dark.png"), 0, 0, W, H)
scrim(s, 25)
t1 = text(s, M, Inches(4.25), CW, Inches(1.6), "Ghostkeys", size=128, font=XL)
t2 = text(s, M, Inches(6.45), Inches(9), Inches(0.5), "Every blank surface of your MacBook is a key.", size=20, color=INK2)
anim(s, t1, 300, "fade", 1200)
anim(s, t2, 300, "fade", 1200)

# 2 ---------------------------------------------------------------- the product
s = new_slide()
OX, OY = Inches(5.6), Inches(1.4)
L = laptop(s, OX, OY, lit=True)
h = text(s, M, Inches(1.4), Inches(4.2), Inches(2), "Tap the parts that do nothing.", size=40, font=XL, line=1.05)
calls = [("top", "Last app", Inches(4.3)), ("grille-r", "Screenshot", Inches(5.0)), ("palm-l", "Mute", Inches(5.7))]
for key, a_, ly in calls:
    cx, cy = centre(L[key])
    text(s, M, ly, Inches(3), Inches(0.4), a_, size=20)
    seg(s, M + Inches(2.4), ly + Inches(0.2), cx, cy, color=EDGE, dash=True)
    dot(s, cx, cy, Inches(0.07))

# 3 ---------------------------------------------------------------- the hard part (real data)
s = new_slide()
h = text(s, M, Inches(0.9), Inches(11.5), Inches(1.0), "A tap looks a lot like a keystroke.", size=40, font=XL)
CH_X, CH_W, CH_H = M, CW, Inches(1.8)
ymax = max(max(p[1] for p in SIG["taps"]), max(p[1] for p in SIG["typing"]))


def chart(pts, top, lab):
    base = top + CH_H
    seg(s, CH_X, base, CH_X + CH_W, base, color=INK4)
    tmax = pts[-1][0] or 1
    xy = [(int(CH_X + CH_W * p[0] / tmax), int(base - CH_H * min(p[1] / ymax, 1.0))) for p in pts]
    line = poly(s, xy, color=LIT, width=0.9)
    small(s, CH_X, top - Inches(0.1), lab, color=INK2)
    return line


l1 = chart(SIG["taps"], Inches(2.4), "Taps")
l2 = chart(SIG["typing"], Inches(4.75), "Typing")
text(s, M, Inches(6.85), CW, Inches(0.4), "Real sensor data, 800 readings a second. Ghostkeys learns the difference, on the laptop.",
     size=14, color=INK3)
anim(s, l1, 400, "wipe", 1400)
anim(s, l2, 400, "wipe", 1400)

# 4 ---------------------------------------------------------------- results
s = new_slide()
h = text(s, M, Inches(0.9), Inches(11.5), Inches(1.0), "It works.", size=40, font=XL)
res = [("1.4%", "wrong taps", "from 16.5%"), ("0", "false taps when you move it", "from 2 a minute"), ("84%", "taps caught on a lap", "from 0%")]
cw = CW / 3
for i, (big, what, before) in enumerate(res):
    x = int(M + cw * i)
    seg(s, x, Inches(2.8), x + int(cw) - Inches(0.5), Inches(2.8), color=INK4)
    text(s, x, Inches(3.0), int(cw), Inches(1.6), big, size=96, font=XL)
    text(s, x, Inches(4.7), int(cw) - Inches(0.4), Inches(0.5), what, size=18)
    small(s, x, Inches(5.2), before, color=INK3)
text(s, M, Inches(6.7), CW, Inches(0.4), "Measured on our own recordings and re-checked independently.", size=13, color=INK3)

# 5 ---------------------------------------------------------------- business
s = new_slide()
h = text(s, M, Inches(0.9), Inches(11.5), Inches(1.0), "Nothing to buy. Pay once.", size=40, font=XL)
tiers = [("Free", "$0", "two palm buttons"), ("Pro", "$29", "once, everything"), ("Teams", "$49", "per seat, per year")]
for i, (n_, p_, d_) in enumerate(tiers):
    x = int(M + cw * i)
    seg(s, x, Inches(2.8), x + int(cw) - Inches(0.5), Inches(2.8), color=LIT if i == 1 else INK4, width=1.0 if i == 1 else 0.75)
    small(s, x, Inches(3.0), n_, color=INK2)
    text(s, x, Inches(3.35), int(cw), Inches(1.6), p_, size=96, font=XL)
    text(s, x, Inches(5.0), int(cw) - Inches(0.4), Inches(0.5), d_, size=18, color=INK2)
text(s, M, Inches(6.7), CW, Inches(0.4), "Every Apple silicon MacBook already has the sensor. Free during the beta.", size=13, color=INK3)

# 6 ---------------------------------------------------------------- close
s = new_slide()
pic = picture(s, os.path.join(IMG, "grille-dark.png"), 0, 0, W, H)
scrim(s, 40)
t1 = text(s, M, Inches(4.9), CW, Inches(1.2), "Try it on the laptop in front of you.", size=46, font=XL)
t2 = text(s, M, Inches(6.0), CW, Inches(0.4), "ghostkeys-nine.vercel.app        github.com/Soham109/ghostkeys", size=13, font=MONO, color=INK2)
anim(s, t1, 300, "fade", 1200)

slides = list(prs.slides)
for s in slides:
    write_timing(s)
    write_transition(s)

out = os.path.join(HERE, "Ghostkeys-pitch.pptx")
prs.save(out)
print(out)
