# tools

Scripts that prepare things, on the machine being read or on this one. They are
standalone: each does one job and says what it does, and the reasons live here
rather than in their comments.

| script               | runs on  | what it does                                          |
| -------------------- | -------- | ----------------------------------------------------- |
| `plain_view.py`      | Windows  | Toggles Notepad++ into a plain, high-contrast view     |
| `overlay.py`         | Windows  | Draws corner markers around the editor pane            |
| `render-fixtures.mjs`| here     | Draws stand-in editor windows into `tests/fixtures/`   |
| `generate-atlas.mjs` | here     | Builds the glyph atlas into `public/atlas/`            |

## Why plain view looks the way it does

Recognition segments a photographed window into a fixed character grid and
matches each cell against a template. Every setting the script changes exists
to make one of those steps possible.

**Black on white, no bold, italic or underline, one size.** Templates are one
weight in one face. A syntax theme puts half a dozen variants on screen, and a
bold or italic glyph correlates badly against an upright regular one. Underline
is worse than either: it puts ink in cells that are otherwise blank.

**A grey line number margin.** The boundary between the margin and the page is
found as a step in background brightness. Painted the same white as the page
there is no step to find, and the first thing that looks like one is the left
edge of the digits.

**No gap between the margin and the text (`TEXT_GAP = 0`).** The margin's left
padding is painted in the text's background colour, so a gap sits on the text's
side of that boundary and offsets every column in every row by its width.

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
size is deliberately left blank there: Scintilla takes the line height from the
tallest style in the editor, the gutter included, so a size set on the margin
changes line spacing for ordinary editing too. The script sets the size itself
while plain view is on.

The margin is the one place a different face is survivable — line numbers are
read from the shape of their ink rather than sliced at the text's cell width
(`src/pipeline/lineNumbers.ts`), and two fixtures cover exactly that case — but
a matching face is still the reference.

**Display scaling held still.** A point size maps to a different number of
pixels at different Windows scaling, so the same `SIZE` is a different size on
screen. Keep it at 100% if anything downstream measures in pixels.

## The test text

For anything that will be measured, have `tests/fixtures/screen-test.txt` open
in Notepad++, from the repository checkout, scrolled to line 1, and choose it
under "Text on screen" on the app's start screen. Captures saved then name it,
and are scored against it as they are dropped into `tests/fixtures/` - nobody
has to read the text back off the photograph.

It is written for the job rather than borrowed. `plain_view.py`, which earlier
captures showed, changed between sessions, so what was on screen had to be
worked out after the fact; and it is mostly lower-case prose, which never
tests a `0` against an `O` or a `1` against an `l`. The test text is 23 lines,
one screenful of the pane the photographs so far were taken of, with:

- every printable ASCII character, three times or more;
- rows of the characters most easily mistaken for each other: `0O o 1lI|`,
  `rn m`, `cl d`, `vv w`, `,.;:`, `'"` and a backtick;
- lines running to 78 columns, so the text reaches the right-hand side of the
  pane, which is where a grid that is slightly out shows it most;
- several depths of indentation, and one blank line.

Leave it unedited: its lines are the ground truth. On a pane too short to show
all of it, or scrolled, add `"lines": [first, last]` to the capture's sidecar -
the range is on the overlay's label in the photograph.

## The corner markers

`overlay.py` draws an L at each corner of the editor pane. The L's outer
corner — where its two long outer edges meet — sits exactly on the pane's
corner, and the markers sit outside the pane, over the tab bar above and the
status bar below, so they never cover text.

Four points are what the whole character grid is laid out from, which is why
they are marked at all rather than guessed at. Everything about the shape is in
service of finding them again in a photograph:

- **An L, not a dot or a cross.** Two long straight edges meeting at a right
  angle can be fitted as lines and intersected, and a line fitted to forty
  pixels of edge is far steadier than any single extreme pixel. It also means
  the shape says which corner it is: an L covers two edges of its own bounding
  box, so the quadrant diagonally opposite its corner is empty, and which
  quadrant that is names the corner without reference to the other three.
- **Black on a white tile.** The tile extends `MARGIN` past the L on every side
  facing the window chrome, so the L is an isolated black shape on white
  whatever is behind it — light theme, dark theme, or desktop. The side facing
  the pane needs no margin: the pane is white already, and stopping the tile at
  the pane edge is what lets the L's corner sit on the pane's corner without
  covering anything.
- **`ARM` by `THICK`, at 100% scaling, scaled by the pane's DPI.** The ratio of
  the two decides how much of the L's bounding box is ink — about a third —
  and being a ratio it holds at any distance from the screen.

No one of those is what identifies a marker, and the detector does not try to
judge a blob on its own account. A photographed marker is blurred, compressed
and thresholded until its arms are thinner than they were drawn, while the
editor below it is full of crisp glyphs — an L, a J, a 7 — that are better L's
than it is by every measure a single shape offers. What the four markers have
that scattered text does not is each other: they are one size, one to a corner,
around a pane that fills a good part of the shot, and each one's L points the
way its position says it should. The shape tests above only decide what is
worth considering; the four are then chosen together, largest first, because
the markers bound the pane and any four pieces of text that happen to form a
quad form a smaller one inside it.

`tools/marker-geometry.json` holds `ARM`, `THICK` and `MARGIN`. The fixture
renderer and the detector both read it. `overlay.py` keeps its own copy, since
it runs on a different machine and imports nothing, and a test reads the
constants back out of it and fails if the two have drifted apart.

## The profile line

`overlay.py` also prints the character grid, as the editor itself reports it:

```
profile: 985 x 563, cell 10.750 x 23, text at 42
```

That is the pane's size, one cell's width and height, and where the first
column of text starts, in screen pixels from the pane's top-left corner. Typed
or pasted into the app's start screen, it replaces searching the photograph for
the grid with laying it out: a capture framed by the markers is the pane and
nothing else, so every one of those numbers is a fixed multiple of its pixels.

**Why the editor is asked rather than the font.** A point size and a display
scaling do not settle the grid. Cascadia Mono at 14 pt comes to 10.94 px a cell
by its metrics; the photographs measure 10.75. The editor lays text out in
fractions of a pixel and adds padding of its own, and only it knows the result.

**How it is asked.** Only messages that take and return integers, the same kind
`plain_view.py` already sends, since a pointer handed to another process means
nothing there. The cell width is how far a line's text runs across the pane
over how many columns it has, pooled over every line on screen that is at least
20 characters and fits on one row, so one pixel of rounding at each end comes
to a few thousandths of a pixel per cell. Lines whose width per column is
unlike the rest - wide characters - are left out.

**When it cannot be read**, the line gives the pane's size alone and the next
one says why: Notepad++ running as administrator (its messages go unanswered),
or no line long enough on screen. The size alone is still worth giving.

**When it is wrong.** A profile printed before the window was resized or the
font changed describes another grid, and the app checks for both on every
capture. The camera's own measure of the pane's proportions is within 1% of
the truth, so a size more than 2% from it is set aside. And the text is asked
which cell width it lines up best at: within 3% of the profile's, the profile
stands; a font size away - about 7% - it is set aside. Either way the grid is
then estimated from the photograph, as it was before there was a profile, and
the result screen says why.

It is printed whenever the pane moves or resizes, or the line height or zoom
changes. Keep display scaling at 100%: the pane's size is in device pixels, and
at other scalings the editor may be answering in scaled ones.

Status: the overlay is a standalone test version, run by hand while plain view
is on. `plain_view.py` does not launch it.

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
