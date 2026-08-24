"""
Build the Windows app icon from the badge art.

The badge is 758x704 (slightly wider than tall). Fitted to a square canvas it
leaves transparent margin top and bottom, which makes it read smaller than
neighbouring taskbar icons. SCALE_BOOST enlarges it and centre-crops, trading a
little of the rounded corner for presence in the taskbar.
"""
import os
import sys
from PIL import Image

ASSETS = r"C:\.lcl\app\assets"
SRC = os.path.join(ASSETS, "mark.png")
SIZE = 512
# The badge is already full-bleed horizontally at boost 1.0, so any boost crops
# the sides. Past ~1.10 the rounded corners are cut off entirely and it reads as
# a hard square, losing the shape of the mark. 1.07 is the most size we can take
# while the corners still curve.
SCALE_BOOST = float(os.environ.get("LCL_ICON_BOOST", "1.07"))
PREVIEW = sys.argv[1] if len(sys.argv) > 1 else None

badge = Image.open(SRC).convert("RGBA")

# fit to the canvas, then enlarge past it so the art fills more of the square
fit = SIZE / max(badge.size)
scale = fit * SCALE_BOOST
target = (max(1, round(badge.width * scale)), max(1, round(badge.height * scale)))
scaled = badge.resize(target, Image.LANCZOS)

canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
canvas.paste(scaled, ((SIZE - target[0]) // 2, (SIZE - target[1]) // 2), scaled)

canvas.save(os.path.join(ASSETS, "icon.png"))
canvas.save(os.path.join(ASSETS, "icon.ico"),
            sizes=[(256, 256), (128, 128), (96, 96), (64, 64), (48, 48), (32, 32), (16, 16)])

# how much of the canvas the visible art now covers, vs before
alpha = canvas.getchannel("A")
bbox = alpha.point(lambda a: 255 if a > 8 else 0).getbbox()
cover = ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) / (SIZE * SIZE) * 100

print(f"badge      : {badge.size}")
print(f"drawn at   : {target}  (boost {SCALE_BOOST:.2f})")
print(f"visible box: {bbox}  -> {cover:.1f}% of the icon canvas")
print(f"wrote      : icon.png, icon.ico")

if PREVIEW:
    # show it at real taskbar sizes against a dark bar
    strip = Image.new("RGB", (300, 80), (28, 28, 32))
    x = 16
    for s in (32, 48, 64):
        thumb = canvas.resize((s, s), Image.LANCZOS)
        strip.paste(thumb, (x, (80 - s) // 2), thumb)
        x += s + 24
    strip.save(PREVIEW)
    print(f"preview    : {PREVIEW}")
