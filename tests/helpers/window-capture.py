"""Capture the LCL Electron window via PrintWindow (works even if occluded)."""
import ctypes
from ctypes import wintypes
from PIL import Image

OUT = r"C:\Users\you\AppData\Local\Temp\claude\C---lcl\bbb271c1-6e74-4b49-b762-e6cc4761e6f1\scratchpad\ui-v2.png"

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
user32.SetProcessDPIAware()

hwnd = user32.FindWindowW(None, ".lcl") or user32.FindWindowW(None, "LCL")
assert hwnd, ".lcl window not found"

rect = wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
w, h = rect.right - rect.left, rect.bottom - rect.top
print("window:", w, "x", h)

hdc = user32.GetWindowDC(hwnd)
mem = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
gdi32.SelectObject(mem, bmp)

PW_RENDERFULLCONTENT = 2
ok = user32.PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT)
print("PrintWindow:", ok)

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]

bmi = BITMAPINFOHEADER()
bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bmi.biWidth = w
bmi.biHeight = -h  # top-down
bmi.biPlanes = 1
bmi.biBitCount = 32
bmi.biCompression = 0

buf = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bmi), 0)

img = Image.frombuffer("RGB", (w, h), buf, "raw", "BGRX", 0, 1)
img.save(OUT)
print("saved", OUT)

gdi32.DeleteObject(bmp)
gdi32.DeleteDC(mem)
user32.ReleaseDC(hwnd, hdc)
