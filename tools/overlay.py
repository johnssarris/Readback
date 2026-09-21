"""
overlay.py: corner markers around the Notepad++ editor pane (test version).

Draws four black L-shaped markers whose corner points sit exactly on the
corners of the Notepad++ editor pane: the text area plus line numbers, not
including the scrollbar. The markers sit just outside the pane, over the tab
bar above and the status bar below, so they never cover text, and they still
work with the window maximized.

This is a standalone test for checking marker placement on a real screen.
With plain view on, run from a terminal:
    python overlay.py

It follows the window as it moves or resizes, hides while Notepad++ isn't the
active window, and exits when plain view is toggled off (plain_view.py deletes
its state file) or Notepad++ closes.

Marker geometry. Sizes are at 100% display scaling and scale with the
pane's DPI:
  - each marker is an L made of two black bars, ARM long and THICK wide
  - the top markers sit above the pane, the bottom markers below it
  - each L's corner point, where its two outer edges meet, is the pane corner:
      top-left marker     -> its bottom-left corner
      top-right marker    -> its bottom-right corner
      bottom-left marker  -> its top-left corner
      bottom-right marker -> its top-right corner
Each L sits on a white tile that extends MARGIN beyond it on its outer sides,
so the marker is black on white whatever the chrome behind it looks like
(light theme, dark theme, or desktop). On its inner sides the L borders the
editor pane itself, which plain view keeps white.
"""

import ctypes
import json
import os
from ctypes import wintypes as wt

u32 = ctypes.windll.user32


def make_dpi_aware():
    """Report real device pixels. Must run before any window exists, Tk's included."""
    try:
        u32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        if u32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return "per-monitor v2"
    except AttributeError:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return "per-monitor"
    except (AttributeError, OSError):
        pass
    u32.SetProcessDPIAware()
    return "system"


DPI_MODE = make_dpi_aware()

import tkinter as tk  # noqa: E402  (must come after DPI awareness)

# ---- Settings to tweak ----
ARM = 40            # length of each L arm, px at 100% scaling
THICK = 8           # thickness of each arm, px at 100% scaling
MARGIN = 6          # white border outside the L, px at 100% scaling
POLL_MS = 150       # how often to check where the pane is
KEY = "#ff00ff"     # transparent colour: pixels in this colour are see-through
STATE_FILE = os.path.join(os.environ["TEMP"], "plain_view_state.json")

# ---- Windows API setup ----
u32.FindWindowW.restype = wt.HWND
u32.GetForegroundWindow.restype = wt.HWND
u32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.IsWindow.argtypes = [wt.HWND]
u32.IsWindowVisible.argtypes = [wt.HWND]
u32.IsIconic.argtypes = [wt.HWND]
u32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.GetClientRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.ClientToScreen.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]
u32.GetParent.argtypes = [wt.HWND]
u32.GetParent.restype = wt.HWND
u32.GetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int]
u32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
u32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_ssize_t]
ENUM_PROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020   # mouse clicks pass through
WS_EX_TOOLWINDOW = 0x00000080    # no taskbar button
WS_EX_NOACTIVATE = 0x08000000    # never takes focus from Notepad++


def dpi_scale(hwnd):
    try:
        u32.GetDpiForWindow.argtypes = [wt.HWND]
        return u32.GetDpiForWindow(hwnd) / 96.0
    except AttributeError:
        return 1.0


def saved_editor():
    """The pane plain view was toggled on in, if its state file names one."""
    try:
        with open(STATE_FILE) as f:
            return json.load(f).get("editor")
    except (OSError, ValueError):
        return None


def largest_pane(npp):
    """The main editor: the largest visible Scintilla window."""
    found = []

    def check(hwnd, _):
        name = ctypes.create_unicode_buffer(32)
        u32.GetClassNameW(hwnd, name, 32)
        if name.value == "Scintilla" and u32.IsWindowVisible(hwnd):
            r = wt.RECT()
            u32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append(((r.right - r.left) * (r.bottom - r.top), hwnd))
        return True

    u32.EnumChildWindows(npp, ENUM_PROC(check), 0)
    return max(found)[1] if found else None


def pane_rect(pane):
    """Screen rectangle of the pane's client area (excludes its scrollbar)."""
    r = wt.RECT()
    u32.GetClientRect(pane, ctypes.byref(r))
    p = wt.POINT(0, 0)
    u32.ClientToScreen(pane, ctypes.byref(p))
    return p.x, p.y, p.x + r.right, p.y + r.bottom


# Each corner's window is an s-by-s white tile (s = a + m) holding the L.
# The L is flush with the tile's pane-side edges, so its corner point lands
# on the pane corner; the tile's extra m px are the white margin on the outer
# sides. bars() gives the L's rectangles inside the tile; origin() gives
# where the tile sits relative to the pane rectangle (left, top, right, bottom).
def bars(corner, a, t, m):
    s = a + m
    ys = (s - t, s) if corner[0] == "t" else (0, t)          # horizontal arm
    xs = (m, s) if corner[1] == "l" else (0, a)
    horiz = (xs[0], ys[0], xs[1], ys[1])
    vx = (m, m + t) if corner[1] == "l" else (a - t, a)       # vertical arm
    vy = (m, s) if corner[0] == "t" else (0, a)
    vert = (vx[0], vy[0], vx[1], vy[1])
    return horiz, vert


def origin(corner, rect, a, m):
    left, top, right, bottom = rect
    x = left - m if corner[1] == "l" else right - a
    y = top - a - m if corner[0] == "t" else bottom
    return x, y


class Markers:
    CORNERS = ("tl", "tr", "bl", "br")

    def __init__(self, root):
        self.windows = {}
        self.canvases = {}
        self.size = None
        for c in self.CORNERS:
            win = tk.Toplevel(root)
            win.overrideredirect(True)
            win.attributes("-topmost", True)
            win.attributes("-transparentcolor", KEY)
            win.configure(bg=KEY)
            canvas = tk.Canvas(win, bg=KEY, highlightthickness=0, bd=0)
            canvas.pack(fill="both", expand=True)
            win.update_idletasks()
            self.make_passive(win)
            self.windows[c] = win
            self.canvases[c] = canvas

    @staticmethod
    def make_passive(win):
        """Click-through, no taskbar button, never steals focus."""
        hwnd = u32.GetParent(win.winfo_id()) or win.winfo_id()
        style = u32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
        u32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE,
                              style | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW
                              | WS_EX_NOACTIVATE)

    def place(self, rect, scale):
        a = max(4, round(ARM * scale))
        t = max(2, round(THICK * scale))
        m = max(2, round(MARGIN * scale))
        s = a + m
        if self.size != (a, t, m):
            self.size = (a, t, m)
            for c in self.CORNERS:
                canvas = self.canvases[c]
                canvas.delete("all")
                canvas.configure(width=s, height=s)
                canvas.create_rectangle(0, 0, s, s, fill="white", outline="")
                for x0, y0, x1, y1 in bars(c, a, t, m):
                    canvas.create_rectangle(x0, y0, x1, y1,
                                            fill="black", outline="")
        for c in self.CORNERS:
            x, y = origin(c, rect, a, m)
            self.windows[c].geometry("%dx%d%+d%+d" % (s, s, x, y))

    def hide(self):
        # Moved off-screen rather than withdrawn: showing a window again can
        # activate it, which would take focus from Notepad++.
        for win in self.windows.values():
            win.geometry("+-10000+-10000")


def main():
    npp = u32.FindWindowW("Notepad++", None)
    if not npp:
        raise SystemExit("Notepad++ is not running")
    if not os.path.exists(STATE_FILE):
        raise SystemExit("Plain view is off. Toggle it on first.")

    print("DPI awareness:", DPI_MODE)
    root = tk.Tk()
    root.withdraw()
    markers = Markers(root)
    last = {"rect": None, "shown": None}

    def tick():
        if not u32.IsWindow(npp) or not os.path.exists(STATE_FILE):
            root.destroy()
            return

        pane = saved_editor()
        if not pane or not u32.IsWindow(pane) or not u32.IsWindowVisible(pane):
            pane = largest_pane(npp)

        show = (pane is not None
                and not u32.IsIconic(npp)
                and u32.GetForegroundWindow() == npp)

        if show:
            rect = pane_rect(pane)
            scale = dpi_scale(pane)
            if rect != last["rect"] or last["shown"] is not True:
                markers.place(rect, scale)
                if rect != last["rect"]:
                    l, t, r, b = rect
                    print("pane: left %d, top %d, right %d, bottom %d "
                          "(%d x %d), scale %.2f"
                          % (l, t, r, b, r - l, b - t, scale))
                last["rect"] = rect
        elif last["shown"] is not False:
            markers.hide()
        last["shown"] = show

        root.after(POLL_MS, tick)

    tick()
    root.mainloop()


if __name__ == "__main__":
    main()
