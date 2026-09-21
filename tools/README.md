# tools

Scripts that prepare things, on the machine being read or on this one. They are
standalone: each does one job and says what it does, and the reasons live here
rather than in their comments.

| script               | runs on  | what it does                                          |
| -------------------- | -------- | ----------------------------------------------------- |
| `plain_view.py`      | Windows  | Toggles Notepad++ into a plain, high-contrast view     |
| `render-fixtures.mjs`| here     | Draws stand-in editor windows into `tests/fixtures/`   |
| `generate-atlas.mjs` | here     | Builds the glyph atlas into `public/atlas/`            |

## Why plain view looks the way it does

Recognition segments a photographed window into a fixed character grid and
matches each cell against a template. Every setting the script changes exists
to make one of those steps possible.

**Black on white, no bold, italic or underline, one size.** Templates are one
weight in one face. A syntax theme puts half a dozen variants on screen, and a
bold or italic glyph correlates badly against an upright regular one.

**A grey line number margin.** The boundary between the margin and the page is
found as a step in background brightness. Painted the same white as the page
there is no step to find, and the first thing that looks like one is the left
edge of the digits.

**Grayscale antialiasing rather than ClearType.** Subpixel rendering tints the
edge of every stroke, which shifts the luminance a template is compared
against.

**No caret, no current-line highlight, no change-history markers, no selection.**
Each of them puts ink or colour in a cell that has nothing to do with the
character in it. The caret is the worst of them: it blinks, so it corrupts a
cell in about half of all shots.

**No indent guides and no edge line.** A vertical rule anywhere in the text
area is a column-shaped feature in an image being scanned for column-shaped
features.

**Word wrap on.** A line wider than the window would otherwise run off the
right edge, where nothing can read it. Wrapped rows are recognised and joined
back together.

**Line numbers kept.** The row grid's phase and each row's baseline come from
the numbers in the margin, and they say which line each row belongs to.

**One font, set in three places.** Cascadia Mono, in the UDL's Default style,
the UDL's Number style, and Global Styles > Line number margin. The margin's
size is deliberately left blank there: Scintilla takes a line's height from the
tallest style on the line, so a size set on the margin changes line spacing for
ordinary editing too. The script sets the size itself while plain view is on.

## What the rendered fixtures are, and are not

`render-fixtures.mjs` draws editor windows in Chromium and writes them to
`tests/fixtures/` with a sidecar recording the exact geometry: cell size, body
bounds, gutter edge, row centres, the text on each row and the number beside
it. That makes every measurement in `npm run metrics` checkable against what
was actually drawn.

They are a stand-in, not the real thing. Chromium and the canvas-built glyph
atlas share a rasterizer, so a rendered window flatters that atlas: its numbers
speak to geometry — margins, cell pitch, row detection, blank cells — and not
to how well one rendering of a font matches another. Real screenshots and
photographs drop into the same folder and are measured by the same code; see
`tests/fixtures/README.md`.

Two of the fixtures put the line number margin in a different face from the
text, which is what a machine looks like when that step of the plain-view setup
was skipped.
