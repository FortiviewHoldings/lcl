"""Regenerate mark-small at a size that stays crisp for a 30px slot at DPR 2."""
import os
from PIL import Image

ASSETS = r"C:\.lcl\ui\electron\assets"
src = Image.open(os.path.join(ASSETS, "mark.png")).convert("RGBA")

# 30px CSS height at DPR 2 needs 60 device px; 128px wide gives real headroom
W = 128
h = int(round(W * src.height / src.width))
out = os.path.join(ASSETS, "mark-small.png")
src.resize((W, h), Image.LANCZOS).save(out, optimize=True)

print(f"mark.png       {src.size}")
print(f"mark-small.png ({W}, {h})  {os.path.getsize(out)} bytes")
print(f"covers a 30px slot at DPR 2 (needs 60px tall): {'yes' if h >= 60 else 'NO'}")
