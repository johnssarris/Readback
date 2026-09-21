# Pipeline fixtures

Each fixture is three files sharing a name:

| file          | what it is                                                       |
| ------------- | ---------------------------------------------------------------- |
| `<name>.png`  | the image                                                        |
| `<name>.json` | sidecar: what kind of image it is, and what it shows              |
| `<name>.txt`  | the ground-truth text (shared between fixtures; named in the json) |

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

**`photo`** — shot with a phone, as the app actually sees a screen.

Two of the renders put the line number margin in another face - Courier Prime
and Inconsolata, the OFL fonts closest to Courier New and Consolas, which
cannot be redistributed. That is the machine where the margin was never set to
the text's font, and its advance width is not the text's.

## Adding one

Drop in the PNG, the text file it shows, and a sidecar:

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

That is all a screenshot needs. A **photo** also needs the window's corners in
image pixels, clockwise from the top left, because nothing in the image says
where the window edge is:

```json
{
  "kind": "photo",
  "text": "my-source.txt",
  "corners": [[212, 96], [1840, 141], [1802, 1290], [188, 1233]]
}
```

No code changes are needed for either — the harness picks up whatever is here.

A fixture may also carry a `truth` block (cell pitch, body bounds, gutter edge,
row centers) when the geometry is known exactly, as it is for a render. Metrics
that need it are skipped for fixtures that don't have it; everything measurable
from the text alone — row count, ink accuracy, indentation, CER — is reported
either way.

## Flat and camera

Every non-photo fixture is measured twice. **flat** feeds the image in as it is,
measuring the segmentation on its own. **camera** photographs it first — a
perspective tilt, blur, sensor noise and a lighting gradient, all seeded so the
pixels are identical run to run — measuring the same code against what a real
capture carries. A `photo` fixture is only measured once, since it already is one.
