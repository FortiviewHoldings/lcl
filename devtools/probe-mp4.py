"""Minimal MP4 box walker: codec, dimensions, duration, fps, bitrate."""
import os
import struct
import sys

# the file to probe: first argument, else a Downloads default (no username baked in)
path = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(r"~\Downloads\.lcl.animation.mp4")
data = open(path, "rb").read()
size_bytes = len(data)

def boxes(buf, start, end):
    off = start
    while off + 8 <= end:
        sz = struct.unpack_from(">I", buf, off)[0]
        typ = buf[off + 4:off + 8].decode("latin-1")
        hdr = 8
        if sz == 1:
            sz = struct.unpack_from(">Q", buf, off + 8)[0]
            hdr = 16
        elif sz == 0:
            sz = end - off
        if sz < hdr:
            break
        yield typ, off + hdr, off + sz
        off += sz

def find(buf, start, end, path_types):
    """Descend a box path like ['moov','trak','mdia']."""
    if not path_types:
        yield start, end
        return
    head, rest = path_types[0], path_types[1:]
    for typ, s, e in boxes(buf, start, end):
        if typ == head:
            yield from find(buf, s, e, rest)

info = {"file": os.path.basename(path), "bytes": size_bytes}

# ftyp brand
for typ, s, e in boxes(data, 0, size_bytes):
    if typ == "ftyp":
        info["brand"] = data[s:s + 4].decode("latin-1")
        break

# mvhd -> timescale + duration
for s, e in find(data, 0, size_bytes, ["moov", "mvhd"]):
    ver = data[s]
    if ver == 1:
        ts = struct.unpack_from(">I", data, s + 20)[0]
        dur = struct.unpack_from(">Q", data, s + 24)[0]
    else:
        ts = struct.unpack_from(">I", data, s + 12)[0]
        dur = struct.unpack_from(">I", data, s + 16)[0]
    if ts:
        info["duration_s"] = round(dur / ts, 3)
    break

# video track: codec + dimensions from stsd, frame count from stts/stsz
tracks = []
for ts_s, ts_e in find(data, 0, size_bytes, ["moov", "trak"]):
    t = {}
    for s, e in find(data, ts_s, ts_e, ["mdia", "minf", "stbl", "stsd"]):
        count = struct.unpack_from(">I", data, s + 4)[0]
        off = s + 8
        if count:
            esz = struct.unpack_from(">I", data, off)[0]
            t["codec"] = data[off + 4:off + 8].decode("latin-1")
            # VisualSampleEntry: width/height at +24/+26 after the 8-byte header
            t["width"] = struct.unpack_from(">H", data, off + 8 + 24)[0]
            t["height"] = struct.unpack_from(">H", data, off + 8 + 26)[0]
            void = esz
    for s, e in find(data, ts_s, ts_e, ["mdia", "mdhd"]):
        ver = data[s]
        if ver == 1:
            mts = struct.unpack_from(">I", data, s + 20)[0]
            mdur = struct.unpack_from(">Q", data, s + 24)[0]
        else:
            mts = struct.unpack_from(">I", data, s + 12)[0]
            mdur = struct.unpack_from(">I", data, s + 16)[0]
        t["timescale"] = mts
        t["media_duration"] = mdur
    for s, e in find(data, ts_s, ts_e, ["mdia", "minf", "stbl", "stsz"]):
        t["sample_count"] = struct.unpack_from(">I", data, s + 8)[0]
    if t.get("codec"):
        tracks.append(t)

for t in tracks:
    # only a VisualSampleEntry has meaningful width/height; mp4a would give garbage
    if t.get("codec") in ("avc1", "avc3", "hev1", "hvc1", "vp09", "av01"):
        info["video"] = t
        if t.get("sample_count") and t.get("timescale") and t.get("media_duration"):
            secs = t["media_duration"] / t["timescale"]
            if secs:
                info["fps"] = round(t["sample_count"] / secs, 2)
                info["mbps"] = round((size_bytes * 8) / secs / 1e6, 2)

has_audio = any(t.get("codec") in ("mp4a", "ac-3", "ec-3", "Opus") for t in tracks)
info["tracks"] = [t.get("codec") for t in tracks]
info["has_audio"] = has_audio

# moov before mdat? (matters for fast start / instant first paint)
order = [typ for typ, _s, _e in boxes(data, 0, size_bytes)]
info["box_order"] = order
info["faststart"] = order.index("moov") < order.index("mdat") if "moov" in order and "mdat" in order else None

import json
print(json.dumps(info, indent=1))

codec = (info.get("video") or {}).get("codec", "")
if codec == "avc1":
    print("\nCODEC OK: H.264 — plays in stock Electron, hardware decode when GPU is on.")
elif codec in ("hev1", "hvc1"):
    print("\nPROBLEM: HEVC/H.265 — stock Electron ffmpeg cannot decode this. Needs transcode to H.264.")
elif codec in ("vp09", "vp9 "):
    print("\nCODEC OK-ish: VP9 — supported, but often software-decoded; heavier on a laptop.")
elif codec == "av01":
    print("\nCAUTION: AV1 — decode support varies; likely software. Consider H.264.")
else:
    print(f"\nUNKNOWN codec '{codec}' — verify playback before shipping.")
