# Pipeline fixtures

Each fixture is three files sharing a name:

| file                     | what it is                                                         |
| ------------------------ | ------------------------------------------------------------------ |
| `<name>.png` or `.jpg`   | the image                                                          |
| `<name>.json`            | sidecar: what kind of image it is, and what it shows                |
| `<name>.txt`             | the ground-truth text (shared between fixtures; named in the json) |

A render is a PNG, because it is drawn rather than captured and nothing should
be lost between drawing it and measuring it. A photo is kept as the JPEG the
phone produced: re-encoding it as PNG would preserve every compression artifact
it already has while costing four times the space.

`tests/pipeline.metrics.test.ts` runs every fixture here through the whole
pipeline and prints a table. Run it with `npm run metrics`.

## Kinds

**`render`** — Chromium-rendered stand-in, produced by `npm run fixtures`.
Chromium and the canvas-built glyph atlas share a rasterizer, so these flatter a
canvas atlas and **cannot** settle a question about where the atlas should come
from. Their numbers are geometry only: margins, cell pitch, row detection,
blank-cell segmentation.

**`screenshot`** — a real Notepad++ window, plain view on, captured at 100%
Windows display scaling. This is what the geometry and recognition numbers
should be read from.

**`photo`** — shot with a phone, as the app actually sees a screen. The three
`photo-*` fixtures are one Notepad++ window at three distances, plain view on,
dark chrome, `overlay.py` running. They are the only fixtures here that were
not made by this repository, and the only ones that can say whether the
detector works on a real screen rather than a drawing of one.

Two of the renders put the line number margin in another face - Courier Prime
and Inconsolata, the OFL fonts closest to Courier New and Consolas, which
cannot be redistributed. That is the machine where the margin was never set to
the text's font, and its advance width is not the text's.

## Adding one from the app

The app's **Keep** button, in the adjust step after freezing or on the result
screen, keeps the shot on the phone; **Send n**, on the live screen, then sends
every shot kept that session as one zip, a `.jpg` and a `.json` per shot under
the shot's timestamped name. A shot kept from the result screen also carries
what the app read from it, under `diagnostics.read`. Kept shots survive the app
being closed, and stay kept if the share sheet is dismissed. Unzip it here. If
"Text on screen" was set on the start screen, the sidecar already names the
text (`screen-test.txt`, see `tools/README.md`); otherwise it says
`REPLACE-ME.txt`, and the text the window showed has to be put beside it and
named. A text file longer than the screen is cut to what was on it: from the
top, or from `"lines": [first, last]` (counting from 1) when the sidecar gives
them. Everything else is filled in: the
corners the capture was actually read at, the pane's size when it was given on
the start screen (which the capture measurements need), the grid as
`profile` when the whole profile line was given, and a `diagnostics`
block with the
frame size, what the camera track was doing, and the detector's account of the
frame. Nothing in the harness reads `diagnostics`; it is there for whoever is
working out why that capture went wrong.

## Adding one by hand

Drop in the image, the text file it shows, and a sidecar:

```json
{
  "kind": "screenshot",
  "text": "my-source.txt",
  "note": "Notepad++ 8.6.9, Cascadia Mono 14pt, 100% scaling"
}
```

The text file has to hold exactly what the window shows - if the document
runs past the bottom of the screenful, cut it there, since nothing below the
window edge can be read from the image.

That is all a screenshot needs, and all a **photo** needs too when the corner
markers are in the shot: they are found in the image and the pane's corners
come from them.

Without markers, a photo has to say where the window is, since nothing in the
image does — corners in image pixels, clockwise from the top left:

```json
{
  "kind": "photo",
  "text": "my-source.txt",
  "corners": [[212, 96], [1840, 141], [1802, 1290], [188, 1233]]
}
```

No code changes are needed for any of them — the harness picks up whatever is
here. Markers come first when they are found, then the sidecar's corners, and
a flat capture with neither is taken to be its own frame.

A fixture may also carry a `truth` block (cell pitch, body bounds, gutter edge,
row centers) when the geometry is known exactly, as it is for a render. Metrics
that need it are skipped for fixtures that don't have it; everything measurable
from the text alone — row count, ink accuracy, indentation, CER — is reported
either way.

## Marker captures: `markers/`

Photos first kept for the corner-marker detector, each carrying the four pane
corners, found by eye on a zoomed crop of each marker, and the pane's size as
`overlay.py` printed it:

```json
{
  "kind": "photo",
  "text": "notepad-plain-view-top.txt",
  "note": "what the shot is, and what the detector made of it before",
  "corners": [[73.4, 196.9], [993.9, 215], [960.4, 722], [95.6, 718]],
  "frame": { "width": 1080, "height": 1920, "cropX": 0, "cropY": 400 },
  "paneSize": { "width": 985, "height": 563 }
}
```

`tests/markers.photos.test.ts` requires every one of them, and the three
`photo-*` fixtures above, to be found with every corner within 3 px. Those
corners were checked by eye against the detector's own answer, so they agree
with it to a few hundredths of a pixel: the gate catches a detector that has
got worse, and cannot show one that has got more precise.

A capture whose sidecar names its `text` also joins the metrics run. All eleven
here show lines 7-30 of the `plain_view.py` that was open when they were taken,
which is `notepad-plain-view-top.txt`; one without `text` stays the detector's
alone.

A capture saved from the app goes in cropped to the monitor, so nothing on
the desk around it is committed. Crop losslessly, with offsets on 16 px
boundaries so no block is re-encoded, and subtract the offset from the
corners:

```sh
jpegtran -copy none -crop 1080x944+0+400 -outfile markers/capture-121834.jpg readback-20260922-121834.jpg
```

## Screen profiles

A photo's sidecar may carry the grid `overlay.py` printed for it, in screen
pixels from the pane's corner:

```json
"profile": { "advance": 10.75, "lineHeight": 23, "textLeft": 42 }
```

With it, and `paneSize`, the harness reads the capture the way the app does
with the whole profile line given. Only ever what was printed on the machine:
a guessed one makes the table measure the guess. A render's is taken from what
it recorded drawing. `READBACK_PROFILE=off npm run metrics` leaves every grid
out, keeping the sizes, to measure the estimator on the same fixtures; the
`grid` column says which one read each row, and a line under a row says why a
profile was set aside.

A photo taken at a display scaling other than 100% says so as `"scaling":
1.5` (for 150%), read off the label: the markers are drawn that much larger,
and the capture measurements need to know where their edges are.

With `profile` and `paneSize`, a photo's text is laid out in rows the way the
editor wraps it - at word boundaries, at as many columns as the pane holds -
so the row count, ink, indent and line number columns compare like with like
on a pane too narrow for its lines.

## Capture measurements

For a photo whose markers are found and whose sidecar gives `paneSize`, the
metrics table measures the shot itself, in screen pixels
(`tests/harness/capture.ts`):

- **dens** - camera pixels per screen pixel, over the pane's area. Below 1 the
  camera has fewer samples than the screen has pixels.
- **blur** - the 10-90% rise across the markers' inner edges. A perfectly sharp
  edge reads 0.8 here, not 0: that is bilinear sampling of a step.
- **bow** - how far the middle of the pane's top and bottom boundaries sits
  from the straight line between their ends, positive toward the inside.

For every fixture, **wander** is how far apart the column grid's best phase is
in different sixths of the line, in cells (`columnWander`): zero when one grid
fits the whole line.

## Flat and camera

Every non-photo fixture is measured twice. **flat** feeds the image in as it is,
measuring the segmentation on its own. **camera** photographs it first — a
perspective tilt, blur, sensor noise and a lighting gradient, all seeded so the
pixels are identical run to run — measuring the same code against what a real
capture carries. A `photo` fixture is only measured once, since it already is one.
