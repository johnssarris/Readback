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

Whenever the pane or its font changes it prints a profile line:

    profile: 985 x 563, cell 10.750 x 23, text at 42

the pane's size, one character cell's width and height, and where the first
column of text starts, all in pixels from the pane's top-left corner. If the
cell can't be read, the line gives the size alone and the next line says why.

Marker geometry. Sizes are at 100% display scaling and scale with the
pane's DPI:
  - each marker is an L made of two black bars, ARM long and THICK wide
  - the top markers sit above the pane, the bottom markers below it
  - each L's corner point, where its two outer edges meet, is the pane corner:
      top-left marker     -> its bottom-left corner
      top-right marker    -> its bottom-right corner
      bottom-left marker  -> its top-left corner
      bottom-right marker -> its top-right corner
Each L sits on a white tile that extends MARGIN past it on every side facing
the window chrome, so the L is an isolated black shape on white whatever is
behind it (light theme, dark theme, or desktop). The side facing the editor
pane needs no margin: the pane is white already, and the tile stops at the
pane edge so it never covers text.
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
u32.SendMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
u32.SendMessageW.restype = ctypes.c_ssize_t
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

SCI_GETCOLUMN = 2129
SCI_GETLINEENDPOSITION = 2136
SCI_GETFIRSTVISIBLELINE = 2152
SCI_POINTXFROMPOSITION = 2164
SCI_POINTYFROMPOSITION = 2165
SCI_POSITIONFROMLINE = 2167
SCI_DOCLINEFROMVISIBLE = 2221
SCI_TEXTHEIGHT = 2279
SCI_LINESONSCREEN = 2370
SCI_GETZOOM = 2374

MIN_SPAN = 20       # shortest line, in characters, that a cell width is read from
AGREE = 0.02        # lines further than this share from the median width are left out

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


def sci(pane, msg, w=0, l=0):
    return u32.SendMessageW(pane, msg, w, l)


def font_state(pane):
    """What changes when the font or zoom does: cheap enough to ask every poll."""
    return sci(pane, SCI_TEXTHEIGHT, 0), sci(pane, SCI_GETZOOM)


def grid_profile(pane):
    """
    The character grid, in pixels from the pane's top-left corner:
    (advance, line height, text left), or (None, reason).

    The advance is read off the lines on screen: how far across the pane each
    one's text runs, over how many columns. Every line that is at least
    MIN_SPAN columns long and fits on one row counts; those that disagree
    with the rest (wide characters) are dropped, and the rest are pooled, so
    the answer is good to a few thousandths of a pixel.
    """
    line_height = sci(pane, SCI_TEXTHEIGHT, 0)
    if line_height <= 0:
        return None, ("the editor did not answer; is Notepad++ running as "
                      "administrator?")

    first = sci(pane, SCI_GETFIRSTVISIBLELINE)
    rows = sci(pane, SCI_LINESONSCREEN)
    top = sci(pane, SCI_DOCLINEFROMVISIBLE, first)
    bottom = sci(pane, SCI_DOCLINEFROMVISIBLE, first + rows)
    text_left = sci(pane, SCI_POINTXFROMPOSITION, 0,
                    sci(pane, SCI_POSITIONFROMLINE, top))

    spans = []
    for line in range(top, bottom + 1):
        start = sci(pane, SCI_POSITIONFROMLINE, line)
        end = sci(pane, SCI_GETLINEENDPOSITION, line)
        columns = (sci(pane, SCI_GETCOLUMN, end)
                   - sci(pane, SCI_GETCOLUMN, start))
        if columns < MIN_SPAN:
            continue
        if (sci(pane, SCI_POINTYFROMPOSITION, 0, start)
                != sci(pane, SCI_POINTYFROMPOSITION, 0, end)):
            continue                     # wrapped: it runs over two rows
        width = (sci(pane, SCI_POINTXFROMPOSITION, 0, end)
                 - sci(pane, SCI_POINTXFROMPOSITION, 0, start))
        spans.append((width, columns))

    if not spans:
        return None, ("no line of %d or more characters on one row is on "
                      "screen; scroll to some longer ones" % MIN_SPAN)
    each = sorted(w / c for w, c in spans)
    median = each[len(each) // 2]
    kept = [(w, c) for w, c in spans if abs(w / c / median - 1) <= AGREE]
    advance = sum(w for w, _ in kept) / sum(c for _, c in kept)
    return (advance, line_height, text_left), None


def profile_lines(pane, rect):
    """The profile line, and the reason the cell is missing if it is."""
    left, top, right, bottom = rect
    size = "profile: %d x %d" % (right - left, bottom - top)
    grid, reason = grid_profile(pane)
    if grid is None:
        return [size, "cell not read: " + reason]
    advance, line_height, text_left = grid
    return ["%s, cell %.3f x %d, text at %d"
            % (size, advance, line_height, text_left)]


# Each corner's window is a white tile, (a + 2m) wide by (a + m) tall, holding
# the L. Inside it the L's a-by-a bounding box has m px of white on every side
# that faces the window chrome, so the L never touches the dark tab bar or
# status bar and stays a separate shape. The pane-facing side gets no margin:
# the L is flush with it, which is what puts its corner point on the pane
# corner, and the pane behind it is white anyway. bars() gives the L's two
# rectangles inside the tile; origin() gives where the tile sits relative to
# the pane rectangle (left, top, right, bottom).
def bars(corner, a, t, m):
    x0 = m                                  # the L's bounding box in the tile
    y0 = m if corner[0] == "t" else 0
    hy = (y0 + a - t, y0 + a) if corner[0] == "t" else (y0, y0 + t)
    horiz = (x0, hy[0], x0 + a, hy[1])      # arm along the pane's top/bottom
    vx = (x0, x0 + t) if corner[1] == "l" else (x0 + a - t, x0 + a)
    vert = (vx[0], y0, vx[1], y0 + a)       # arm along the pane's left/right
    return horiz, vert


def origin(corner, rect, a, m):
    left, top, right, bottom = rect
    x = left - m if corner[1] == "l" else right - a - m
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
        w, h = a + 2 * m, a + m
        if self.size != (a, t, m):
            self.size = (a, t, m)
            for c in self.CORNERS:
                canvas = self.canvases[c]
                canvas.delete("all")
                canvas.configure(width=w, height=h)
                canvas.create_rectangle(0, 0, w, h, fill="white", outline="")
                for x0, y0, x1, y1 in bars(c, a, t, m):
                    canvas.create_rectangle(x0, y0, x1, y1,
                                            fill="black", outline="")
        for c in self.CORNERS:
            x, y = origin(c, rect, a, m)
            self.windows[c].geometry("%dx%d%+d%+d" % (w, h, x, y))

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
    last = {"rect": None, "shown": None, "font": None, "profile": None}

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
            font = font_state(pane)
            if (rect, font) != (last["profile"], last["font"]):
                for line in profile_lines(pane, rect):
                    print(line)
                last["profile"], last["font"] = rect, font
        elif last["shown"] is not False:
            markers.hide()
        last["shown"] = show

        root.after(POLL_MS, tick)

    tick()
    root.mainloop()


if __name__ == "__main__":
    main()
