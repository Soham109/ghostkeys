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
h = text(s, M, Inches(0.7), Inches(11.5), Inches(1.0), "A tap looks a lot like a keystroke.", size=40, font=XL)
CH_X, CH_W, CH_H = M, CW, Inches(1.25)
ymax = max(max(p[1] for p in SIG["taps"]), max(p[1] for p in SIG["typing"]))


def chart(pts, top, lab):
    base = top + CH_H
    seg(s, CH_X, base, CH_X + CH_W, base, color=INK4)
    tmax = pts[-1][0] or 1
    xy = [(int(CH_X + CH_W * p[0] / tmax), int(base - CH_H * min(p[1] / ymax, 1.0))) for p in pts]
    line = poly(s, xy, color=LIT, width=0.9)
    small(s, CH_X, top - Inches(0.1), lab, color=INK2)
    return line


l1 = chart(SIG["taps"], Inches(1.95), "Taps")
l2 = chart(SIG["typing"], Inches(3.65), "Typing")
steps = ["Something hit", "Not typing or on the trackpad", "Two models vote on the spot", "Unsure? Do nothing"]
sw = CW / 4
for i, t in enumerate(steps):
    x = int(M + sw * i)
    dot(s, x + Inches(0.06), Inches(5.65), Inches(0.06), fill=LIT if i == 3 else EDGE)
    if i < 3:
        seg(s, x + Inches(0.2), Inches(5.65), int(M + sw * (i + 1)) - Inches(0.1), Inches(5.65), color=INK4)
    text(s, x, Inches(5.85), int(sw) - Inches(0.3), Inches(0.7), t, size=16, line=1.15)
text(s, M, Inches(6.85), CW, Inches(0.4), "Real sensor data, 800 readings a second. 33 measurements per tap. All on the laptop.",
     size=13, color=INK3)
anim(s, l1, 400, "wipe", 1400)
anim(s, l2, 400, "wipe", 1400)

# S ---------------------------------------------------------------- sonar
s = new_slide()
h = text(s, M, Inches(1.4), Inches(4.6), Inches(2), "Hands in the air. No camera.", size=40, font=XL, line=1.05)
text(s, M, Inches(3.4), Inches(4.2), Inches(1.4), "The speakers play two tones too high to hear. The mic hears your hand bend them.",
     size=16, color=INK2, line=1.25)
small(s, M, Inches(5.2), "Raise or lower your hand: volume", color=INK2, w=Inches(4.5))
small(s, M, Inches(5.55), "Push over a side: switch apps", color=INK2, w=Inches(4.5))
bx, by = Inches(6.2), Inches(5.6)
seg(s, bx, by, bx + Inches(5.6), by, color=EDGE, width=1.25)
seg(s, bx + Inches(5.6), by, bx + Inches(6.3), by - Inches(3.7), color=EDGE, width=1.25)
spL = dot(s, bx + Inches(1.2), by - Inches(0.08), Inches(0.08), fill=EDGE)
spR = dot(s, bx + Inches(4.4), by - Inches(0.08), Inches(0.08), fill=EDGE)
dot(s, bx + Inches(2.8), by - Inches(0.08), Inches(0.05), fill=LIT)
arcs = []
for spk in (spL, spR):
    cx, cy = centre(spk)
    for k in range(1, 5):
        r = Inches(0.35 * k)
        a = s.shapes.add_shape(MSO_SHAPE.ARC, cx - r, cy - r, 2 * r, 2 * r)
        a.adjustments[0] = 180.0
        a.adjustments[1] = 0.0
        a.line.color.rgb = INK4 if k > 2 else EDGE
        a.line.width = Pt(0.75)
        a.fill.background()
        a.shadow.inherit = False
        arcs.append(a)
box(s, bx + Inches(2.3), by - Inches(2.55), Inches(1.1), Inches(0.42), line=LIT, radius=0.5, width=1.0)
seg(s, bx + Inches(2.85), by - Inches(2.1), bx + Inches(2.8), by - Inches(0.2), color=LIT, dash=True)
small(s, bx + Inches(0.75), by + Inches(0.15), "speaker")
small(s, bx + Inches(2.55), by + Inches(0.15), "mic", color=INK2)
small(s, bx + Inches(3.95), by + Inches(0.15), "speaker")
for i, a in enumerate(arcs):
    anim(s, a, 300 + (i % 4) * 200, "fade", 600)

# C ---------------------------------------------------------------- camera
s = new_slide()
h = text(s, M, Inches(1.4), Inches(5.3), Inches(1), "Or use the camera.", size=40, font=XL, line=1.05)
text(s, M, Inches(2.4), Inches(4.4), Inches(1.4), "Optional and off by default. Pinch in front of the screen to control things from across the desk.",
     size=16, color=INK2, line=1.25)
gests = ["Air tap", "Pinch and turn, like a dial", "Pinch and drag", "Palm swipe"]
for i, g in enumerate(gests):
    y = Inches(4.3) + Inches(0.5) * i
    seg(s, M, y, M + Inches(4.2), y, color=INK4)
    text(s, M, y + Inches(0.1), Inches(4.2), Inches(0.4), g, size=16)
small(s, M, Inches(6.5), "Processed on the Mac. No video is saved or sent.", color=INK3, w=Inches(6))
# front view: screen, camera, field of view
sx, sy, sw_, sh_ = Inches(6.4), Inches(1.3), Inches(5.9), Inches(3.7)
box(s, sx, sy, sw_, sh_, line=EDGE, radius=0.04)
box(s, sx + Inches(0.2), sy + Inches(0.25), sw_ - Inches(0.4), sh_ - Inches(0.45), line=INK4, radius=0.02)
cam = dot(s, sx + sw_ // 2, sy + Inches(0.13), Inches(0.05), fill=LIT)
seg(s, sx - Inches(0.3), sy + sh_ + Inches(0.05), sx + sw_ + Inches(0.3), sy + sh_ + Inches(0.05), color=EDGE, width=1.25)
ccx, ccy = centre(cam)
hand = box(s, sx + sw_ // 2 - Inches(0.55), Inches(5.75), Inches(1.1), Inches(0.42), line=LIT, radius=0.5, width=1.0)
small(s, sx + sw_ // 2 + Inches(0.7), Inches(5.83), "your hand, in front", color=INK2)
small(s, sx + sw_ // 2 + Inches(0.15), sy + Inches(0.3), "camera", color=INK2)
anim(s, hand, 400, "rise", 900)

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
