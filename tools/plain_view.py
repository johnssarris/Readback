"""
plain_view.py: toggle Notepad++ into a plain, high-contrast view and back.

Runs from a normal Python 3 install and sends standard Windows messages to
Notepad++. No plugin needed. Run once to turn on, run again to restore.

The point of the plain view is to make a photographed Notepad++ window
readable by the Readback pipeline, which segments the text into a fixed
character grid and matches every cell against a glyph atlas.

What "on" does:
  - switches the document to a User Defined Language that supplies the font
  - forces every style to black on white, no bold/italic/underline, fixed size
  - gives the line number margin a grey background, so the margin detector has
    a background step to find at the gutter/text boundary
  - switches font rendering to grayscale antialiasing, so ClearType's colour
    fringing doesn't skew the luminance the matcher works from
  - hides the caret, current-line highlight, and change-history markers
  - hides the bookmark, fold, and change-history margins (keeps line numbers)
  - resets zoom, turns off whitespace symbols, EOL markers, indent guides,
    and the edge line
  - sets word wrap per the WRAP setting below

What "off" does:
  - switches back to the original language, which makes Notepad++ reapply
    the normal theme, then restores every other setting it changed

One-time setup:
  1. In Notepad++: Language > User Defined Language > Define your language...
     Create new, name it exactly as UDL_NAME below. Leave Ext. empty.
     Folder & Default tab > Default style > Styler: font Cascadia Mono,
     size as SIZE below, black on white, bold/italic/underline unchecked.
     Comment & Number tab > Number style > Styler: same settings.
     Restart Notepad++.
  2. Set Settings > Style Configurator > Global Styles > Line number margin
     to Cascadia Mono as well, same size, bold/italic/underline unchecked.
     The gutter takes its font from there, not from the UDL.
  3. Test from a terminal: python plain_view.py  (run twice)
  4. Add a hotkey: Run > Run..., enter
         pythonw "C:\\path\\to\\plain_view.py"
     then Save... and assign a shortcut.

The font matters as much as the colors: Readback's glyph atlas is built from
one specific face, and a cell only matches if the photographed glyph has the
same shape. Cascadia Mono is the reference face (it ships with Windows 11),
and it has to be set in all three places above - the UDL's Default style, the
UDL's Number style, and Global Styles > Line number margin - or the gutter and
the text will be measured against templates they don't match.

Notes:
  - Notepad++ must not be running as administrator. Windows blocks messages
    from a normal process to an elevated one, and nothing will happen.
  - In split view the script targets the larger pane. If the panes change
    between toggling on and off, the saved window is toggled off instead.
  - Windows display scaling changes how many device pixels a point size
    renders to. Anything measured in pixels - SIZE's on-screen height, the
    cell pitch Readback calibrates - shifts with it, so keep scaling fixed
    (100% is the reference) between captures.
  - If the original document was itself a UDL, toggling off can't switch
    back to it. Pick it from the Language menu.
  - Scintilla message IDs are commented inline. The full list is in the
    Scintilla documentation (Scintilla.iface).
"""

import ctypes
import json
import os
from ctypes import wintypes as wt
from functools import partial

# ---- Settings to tweak ----
UDL_NAME = "Plain View"  # User Defined Language that supplies the font
SIZE = 14                # point size
INK = 0x000000           # text color, as 0xBBGGRR
PAPER = 0xFFFFFF         # background color, as 0xBBGGRR
GUTTER = 0xE0E0E0        # line number margin background, as 0xBBGGRR
TEXT_GAP = 0             # pixels between line numbers and text
# Word wrap. False for now: Readback reads one row per line number, so a
# wrapped continuation row - which Notepad++ leaves numberless - is dropped.
# That's a stopgap, and it trades one loss for another: with wrap off, a line
# wider than the window runs off the right edge and is lost just as silently.
# Set back to True once the pipeline detects rows from the text area and
# treats numberless rows as continuations.
WRAP = False
STATE_FILE = os.path.join(os.environ["TEMP"], "plain_view_state.json")
STATE_VERSION = 2        # bump if the saved state format changes

# ---- Windows API setup ----
u32 = ctypes.windll.user32
u32.SendMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
u32.SendMessageW.restype = ctypes.c_ssize_t
u32.FindWindowW.restype = wt.HWND
u32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.IsWindowVisible.argtypes = [wt.HWND]
u32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.GetMenu.argtypes = [wt.HWND]
u32.GetMenu.restype = wt.HMENU
u32.GetSubMenu.argtypes = [wt.HMENU, ctypes.c_int]
u32.GetSubMenu.restype = wt.HMENU
u32.GetMenuItemCount.argtypes = [wt.HMENU]
u32.GetMenuStringW.argtypes = [wt.HMENU, wt.UINT, wt.LPWSTR,
                               ctypes.c_int, wt.UINT]
u32.GetMenuItemID.argtypes = [wt.HMENU, ctypes.c_int]
u32.GetMenuItemID.restype = wt.UINT
u32.InvalidateRect.argtypes = [wt.HWND, ctypes.c_void_p, wt.BOOL]
ENUM_PROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

WM_SETREDRAW = 0x000B
WM_COMMAND = 0x0111
MF_BYPOSITION = 0x400
NPPM_GETCURRENTBUFFERID = 2024 + 60
NPPM_GETBUFFERLANGTYPE = 2024 + 64
NPPM_SETBUFFERLANGTYPE = 2024 + 65
CARET_LINE = 50          # Scintilla element ID for the current-line highlight
LINE_NUMBER = 33         # Scintilla style ID for the line number margin
STYLE_COUNT = 40         # UDL styles are 0-24; predefined styles are 32-39
QUALITY_ANTIALIASED = 2  # SC_EFF_QUALITY_ANTIALIASED: grayscale, not ClearType


def find_editor():
    """Return (Notepad++ window, main editor window, all Scintilla panes)."""
    npp = u32.FindWindowW("Notepad++", None)
    if not npp:
        raise SystemExit("Notepad++ is not running")
    panes = []
    visible = []

    def check(hwnd, _):
        name = ctypes.create_unicode_buffer(32)
        u32.GetClassNameW(hwnd, name, 32)
        if name.value == "Scintilla":
            panes.append(hwnd)
            if u32.IsWindowVisible(hwnd):
                r = wt.RECT()
                u32.GetWindowRect(hwnd, ctypes.byref(r))
                visible.append(((r.right - r.left) * (r.bottom - r.top), hwnd))
        return True

    u32.EnumChildWindows(npp, ENUM_PROC(check), 0)
    if not visible:
        raise SystemExit("No editor window found")
    # Panels like Find Results are also Scintilla windows,
    # so take the largest visible one: the main editor.
    return npp, max(visible)[1], panes


def find_menu_item(menu, text):
    """Search a menu and its submenus for an item; return its command ID."""
    for i in range(u32.GetMenuItemCount(menu)):
        sub = u32.GetSubMenu(menu, i)
        if sub:
            found = find_menu_item(sub, text)
            if found:
                return found
        else:
            buf = ctypes.create_unicode_buffer(128)
            u32.GetMenuStringW(menu, i, buf, 128, MF_BYPOSITION)
            if buf.value.replace("&", "") == text:
                return u32.GetMenuItemID(menu, i)
    return None


npp, ed, panes = find_editor()


def sci_to(win, msg, w=0, l=0):
    """Send a Scintilla message to a given editor pane and return the result."""
    return u32.SendMessageW(win, msg, w, l)


def current_buffer():
    return u32.SendMessageW(npp, NPPM_GETCURRENTBUFFERID, 0, 0)


def turn_on(editor):
    sci = partial(sci_to, editor)

    item = find_menu_item(u32.GetMenu(npp), UDL_NAME)
    if not item:
        raise SystemExit('No language named "%s" in the Language menu'
                         % UDL_NAME)

    # Save everything we're about to change
    buf = current_buffer()
    state = {
        "version": STATE_VERSION,
        "editor": editor,
        "buffer": buf,
        "lang": u32.SendMessageW(npp, NPPM_GETBUFFERLANGTYPE, buf, 0),
        "caret_width": sci(2189),                  # SCI_GETCARETWIDTH
        "caret_line": sci(2095),                   # SCI_GETCARETLINEVISIBLE
        "line_color_set": sci(2756, CARET_LINE),   # SCI_GETELEMENTISSET
        "line_color": sci(2755, CARET_LINE),       # SCI_GETELEMENTCOLOUR
        "margins": [sci(2243, i) for i in range(1, 5)],  # SCI_GETMARGINWIDTHN
        "pad": sci(2156),                          # SCI_GETMARGINLEFT
        "hist": sci(2781),                         # SCI_GETCHANGEHISTORY
        "quality": sci(2612),                      # SCI_GETFONTQUALITY
        "zoom": sci(2374),                         # SCI_GETZOOM
        "wrap": sci(2269),                         # SCI_GETWRAPMODE
        "wrap_indent": sci(2473),                  # SCI_GETWRAPINDENTMODE
        "ws": sci(2020),                           # SCI_GETVIEWWS
        "eol": sci(2355),                          # SCI_GETVIEWEOL
        "guides": sci(2133),                       # SCI_GETINDENTATIONGUIDES
        "edge": sci(2362),                         # SCI_GETEDGEMODE
    }
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)

    # Switch to the UDL. This is what sets the font.
    u32.SendMessageW(npp, WM_COMMAND, item, 0)

    # Freeze drawing so the editor repaints once at the end,
    # not after every individual change. The finally block guarantees the
    # editor is never left frozen, however this exits.
    u32.SendMessageW(editor, WM_SETREDRAW, 0, 0)
    try:
        # Every style black on white, no bold/italic/underline, fixed size.
        # Covers the UDL's styles plus the line number gutter (33),
        # brace highlights (34, 35) and indent guides (37).
        for s in range(STYLE_COUNT):
            sci(2051, s, INK)     # SCI_STYLESETFORE
            sci(2052, s, PAPER)   # SCI_STYLESETBACK
            sci(2053, s, 0)       # SCI_STYLESETBOLD
            sci(2054, s, 0)       # SCI_STYLESETITALIC
            sci(2059, s, 0)       # SCI_STYLESETUNDERLINE
            sci(2055, s, SIZE)    # SCI_STYLESETSIZE

        # Black digits on a grey gutter. Readback finds the gutter/text
        # boundary from a step in background brightness, so the margin has to
        # stay a different shade from the page.
        sci(2052, LINE_NUMBER, GUTTER)          # SCI_STYLESETBACK

        # Grayscale antialiasing instead of ClearType: subpixel rendering
        # tints the edge of every stroke, which shifts the luminance the
        # matcher correlates against.
        sci(2611, QUALITY_ANTIALIASED)          # SCI_SETFONTQUALITY

        # Hide the caret and the current-line highlight. The highlight is
        # painted the page color, so it disappears whichever way Notepad++
        # draws it.
        sci(2188, 0)                                # SCI_SETCARETWIDTH
        sci(2096, 0)                                # SCI_SETCARETLINEVISIBLE
        sci(2753, CARET_LINE, 0xFF000000 | PAPER)   # SCI_SETELEMENTCOLOUR

        # Hide bookmark, fold, and change-history margins (keep line numbers)
        for i in range(1, 5):
            sci(2242, i, 0)                         # SCI_SETMARGINWIDTHN
        sci(2155, 0, TEXT_GAP)                      # SCI_SETMARGINLEFT

        # Keep change history enabled but hide its markers. With their margin
        # hidden, Scintilla would otherwise paint whole edited lines green.
        sci(2780, state["hist"] & 1)                # SCI_SETCHANGEHISTORY

        sci(2373, 0)              # SCI_SETZOOM: reset
        sci(2268, 1 if WRAP else 0)  # SCI_SETWRAPMODE: word boundaries, or off
        sci(2472, 0)   # SCI_SETWRAPINDENTMODE: wrapped lines start at column 0
        sci(2021, 0)   # SCI_SETVIEWWS: whitespace symbols off
        sci(2356, 0)   # SCI_SETVIEWEOL: end-of-line markers off
        sci(2132, 0)   # SCI_SETINDENTATIONGUIDES: off
        sci(2363, 0)   # SCI_SETEDGEMODE: vertical edge line off
    finally:
        # Unfreeze and repaint once
        u32.SendMessageW(editor, WM_SETREDRAW, 1, 0)
        u32.InvalidateRect(editor, None, True)


def turn_off(state, editor):
    sci = partial(sci_to, editor)

    # Switching back to the original language makes Notepad++ reapply
    # your normal theme. Skip it if you've moved to another document.
    if current_buffer() == state["buffer"]:
        u32.SendMessageW(npp, NPPM_SETBUFFERLANGTYPE,
                         state["buffer"], state["lang"])

    sci(2188, state["caret_width"])
    sci(2096, state["caret_line"])
    if state["line_color_set"]:
        sci(2753, CARET_LINE, state["line_color"])
    else:
        sci(2754, CARET_LINE)   # SCI_RESETELEMENTCOLOUR
    for i, width in enumerate(state["margins"], 1):
        sci(2242, i, width)
    sci(2155, 0, state["pad"])
    sci(2780, state["hist"])
    sci(2611, state["quality"])
    sci(2373, state["zoom"])
    sci(2268, state["wrap"])
    sci(2472, state["wrap_indent"])
    sci(2021, state["ws"])
    sci(2356, state["eol"])
    sci(2132, state["guides"])
    sci(2363, state["edge"])
    os.remove(STATE_FILE)


# ---- Toggle ----
# The saved editor handle is what state belongs to, which isn't always the
# pane we'd pick now: splitting the view, or resizing one, changes which pane
# is largest. As long as that window is still one of this Notepad++'s panes,
# toggle it off there. Only a handle that's gone - Notepad++ restarted, taking
# the plain view with it - means the state is stale.
state = None
target = ed
if os.path.exists(STATE_FILE):
    with open(STATE_FILE) as f:
        state = json.load(f)
    if state.get("version") != STATE_VERSION:
        state = None            # saved by an older version of this script
    elif state.get("editor") in panes:
        target = state["editor"]
    else:
        state = None            # that editor is gone; nothing to restore

if state:
    turn_off(state, target)
else:
    turn_on(target)
