"""
Brand assets v4.

  assets/wordmark.png       .lcl.overlay.png verbatim (archival copy)
  assets/wordmark-trim.png  same art with the fully-transparent margin cropped
                            away — ZERO visible pixels changed, it just lets CSS
                            centre and size the mark correctly. Used in the UI.
  assets/mark.png           .lcl.app-icon.v2.png verbatim (top bar badge source)
  assets/mark-small.png     64px badge for the 17px titlebar / 22px modal slots
  assets/icon.png / .ico    badge padded (never cropped) onto a square canvas
  assets/logo.png           left alone (no longer referenced by the UI)
  assets/landing.mp4        left alone
"""
import hashlib
import os
import shutil
import tempfile
from PIL import Image

# resolved from the environment so no username is baked into the repo; override
# the sources via LCL_BRAND_SRC if your art lives elsewhere
_SRC = os.environ.get("LCL_BRAND_SRC", os.path.expanduser("~/Downloads"))
OVERLAY_SRC = os.path.join(_SRC, ".lcl.overlay.png")
ICON_SRC = os.path.join(_SRC, ".lcl.app-icon.v2.png")
ASSETS = os.path.join(os.environ.get("LCL_REPO", r"C:\.lcl"), "app", "assets")
PREVIEW = os.path.join(tempfile.gettempdir(), "lcl-brand-preview")


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()[:12]


# ---- wordmark: verbatim + alpha-trimmed ----
shutil.copyfile(OVERLAY_SRC, os.path.join(ASSETS, "wordmark.png"))
word = Image.open(OVERLAY_SRC).convert("RGBA")
bbox = word.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
trimmed = word.crop(bbox)
trimmed.save(os.path.join(ASSETS, "wordmark-trim.png"), optimize=True)
print(f"wordmark.png      {word.size} verbatim")
print(f"wordmark-trim.png {trimmed.size} ratio {trimmed.width/trimmed.height:.3f} "
      f"({os.path.getsize(os.path.join(ASSETS, 'wordmark-trim.png'))} bytes)")

# prove the trim removed only transparent pixels
alpha_before = word.getchannel("A")
nonzero_before = sum(1 for a in alpha_before.getdata() if a > 8)
nonzero_after = sum(1 for a in trimmed.getchannel("A").getdata() if a > 8)
print(f"visible pixels: {nonzero_before} -> {nonzero_after}  "
      f"{'IDENTICAL' if nonzero_before == nonzero_after else 'LOST PIXELS!'}")

# ---- badge / app icon from icon v2 ----
shutil.copyfile(ICON_SRC, os.path.join(ASSETS, "mark.png"))
badge = Image.open(ICON_SRC).convert("RGBA")
print("mark.png:", badge.size)

h = int(round(64 * badge.height / badge.width))
badge.resize((64, h), Image.LANCZOS).save(os.path.join(ASSETS, "mark-small.png"), optimize=True)
print("mark-small.png:", (64, h), os.path.getsize(os.path.join(ASSETS, "mark-small.png")), "bytes")

SIZE = 512
scale = SIZE / max(badge.size)
target = (max(1, round(badge.width * scale)), max(1, round(badge.height * scale)))
scaled = badge.resize(target, Image.LANCZOS)
icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
icon.paste(scaled, ((SIZE - target[0]) // 2, (SIZE - target[1]) // 2), scaled)
icon.save(os.path.join(ASSETS, "icon.png"))
icon.save(os.path.join(PREVIEW, "icon-v4-preview.png"))
icon.save(os.path.join(ASSETS, "icon.ico"),
          sizes=[(256, 256), (128, 128), (96, 96), (64, 64), (48, 48), (32, 32), (16, 16)])
print("icon.png / icon.ico:", icon.size, "badge at", target)

# ---- untouched assets ----
for name in ("logo.png", "landing.mp4"):
    p = os.path.join(ASSETS, name)
    if os.path.exists(p):
        print(f"{name}: untouched, sha {sha(p)}")
