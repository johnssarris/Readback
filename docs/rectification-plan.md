# What to do with four known corners

A plan, not a record of what was built. It takes the list of ideas that came
out of getting the corner markers working, checks each against the code as of
43b2b59, and puts what is left in an order. Steps 1-3 are done in code; nothing after them has been implemented.

## What the photographs say

Measured on the fourteen real captures in `tests/fixtures` (the three `photo-*`
stills and the eleven in `markers/`), all of the same 985 x 563 pane. The
measurements were throwaway scripts; step 1 below makes them permanent.

| quantity                                                   | measured                               |
| ---------------------------------------------------------- | -------------------------------------- |
| pane aspect from the corners through the assumed camera    | within 0.9% on all fourteen            |
| camera px per screen px, app video frames (1080p)          | **0.73 - 0.98**                        |
| camera px per screen px, the three stills                  | 1.2 - 1.6                              |
| marker inner edge, 10-90% rise, in screen px (sharp = 0.8) | video 1.3 - 2.7, stills 1.4 - 1.9      |
| marker arm thickness at the 50% level (drawn 8)            | 5.9 - 7.5                              |
| pane top/bottom boundary vs the line between its corners   | **1 - 4 screen px off at mid-edge**    |
| column grid phase, left to right across the pane (stills)  | wanders +-0.10 - 0.15 cell, S-shaped   |
| row pitch from `calibrateCellPitch`                        | 22.72 - 22.90 px (likely 23 exactly)   |
| cell width from `calibrateCellPitch`                       | 10.75 px - fractional, and not the 10.94 that 14 pt Cascadia Mono predicts |
| `calibrateCellPitch` on a 1:1 rectification of photo-near  | fails: locks onto 16.0 px              |
| marker detection time                                      | ~100 ms on 1080 x 944, ~210 ms on a 1080p frame, ~490 ms on a 5 MP still (desktop Node) |
| `npm run metrics`, stills                                  | rows 24/24, ink 94-95%, indent 29-81%, CER 29-46% |
| `npm run metrics`, video captures in `markers/`            | CER 28-99%                             |

Three conclusions carry the rest of this document.

**The corners are not the limit.** The mid-edge bow is fifty times any
plausible corner error. Work that sharpens the corners further buys nothing
until the bow is gone.

**The frame is.** The app reads a 1080p video frame, which puts fewer camera
pixels on the pane than the pane has screen pixels, blurred over about two of
them, against glyph strokes one or two pixels wide. The stills do better on both
counts and still come out at 29-46% CER, so resolution is necessary, not
sufficient.

(The first rough blur figures, 3-5 px on video, were read across the arm edge
that faces the pane, where the first line of text sits a few pixels away. The
harness reads the inner edges, which face clear white, and gets 1.3-2.7.)

**The moire is baked in at capture.** The rings in every photo are the sensor
sampling the screen's pixel grid. Nothing done to the pixels after that can
remove them by filtering; see flat-fielding and stacking below.

A methodological note: the hand-marked corners in `markers/*.json` agree with
the detector to about 0.05 px on most captures, so they were effectively taken
from its output. The 3 px gate in `tests/markers.photos.test.ts` is a
regression guard, not a precision measure, and cannot show a sub-pixel
improvement either way.

## Part 1: the app side

### Already handled

**Rotation, skew, perspective.** `warpImageData` applies one projective map,
which covers all three. There is no separate de-rotate or de-skew step to
write. What it does not correct, largest first by what was measured:

- **Camera-side distortion.** The displays are flat, so the 2-3 px mid-edge bow
  comes from the camera: residual lens distortion after the phone's own
  correction, or the non-rigid warp video stabilisation applies to each frame.
  It does not fit a simple radial model about the frame centre: on most shots
  both the top and bottom boundaries bow toward the pane's middle, which is
  pincushion when the pane straddles the centre, but on the two shots where the
  pane sits wholly above the centre (140953, 141014) both bow outward, which
  neither pincushion nor barrel about the centre produces. Hence the plan below
  measures the boundaries rather than assuming a model.
- **Blur**, defocus and motion together: 1.3-2.7 screen px.
- **Moire and JPEG compression.**
- **The tone curve.**
- **Rolling shutter.** Its shear is close to affine and mostly absorbed by the
  homography; any wobble within a frame is not.

**True aspect ratio.** `estimatePaneAspect` in `src/pipeline/rectify.ts`
already uses the typed pane size when there is one, and otherwise takes the
corners back through an assumed camera, which gets within 0.9%. Averaging the
edges is only the fallback. The marker-as-ruler version would be worse, not
better: thresholded arms come out 5.9-7.5 px against 8 drawn, so a 40 px
feature is a few percent out, where the pane's corners span 985 px.

**Eight lines rather than four points.** The detector already fits both outer
edges of each L by total least squares and intersects them (`fitCorner` in
`src/pipeline/markers.ts`). Joining collinear arms across the pane would
assume the very straightness the measurements contradict, and the arm
segments (about 32 px usable) are too short for their angles to resolve a
2 px bow. The pane's own boundaries do that job better; see step 4.

**Per-corner identity.** Each L already names its corner by which quadrant of
its box is empty (`CORNER_BY_EMPTY_QUADRANT`).

### Plumbed but not switched on

**Rectifying at a known scale.** `OutputSizing { kind: "source", paneSize }`
exists and the typed pane size reaches it, but `RECTIFIED_SIZING` in
`src/pipeline/analyze.ts` is still `fixed: 1600`. Exactly one output pixel per
screen pixel is too coarse - it is where calibration broke on photo-near - and
a whole-number multiple buys nothing for columns because the cell is 10.75 px
wide. What a fixed multiple does buy is the same cell size on every capture,
so pixel constants and the atlas can be sized once. Use **2x**: 1970 x 1126
is inside both output bounds.

### Where the original ideas were wrong

**Resampling filter.** Every capture today is an upsample: 0.73-1.6 camera px
per screen px going to 1.62 output px per screen px. Area averaging or Lanczos
only matters when the output is smaller than the source, which at 2x output
means stills above 2 camera px per screen px. Bicubic in place of bilinear is
a small, cheap gain. It is not a moire fix: the moire is formed at the sensor,
before any warp.

**Flat-fielding with a low-order polynomial.** It removes glare and lens
falloff but cannot touch the moire rings, which are 30-60 camera px across.
Use a local background estimate instead - roughly a max filter about 1.5 cells
wide, then smoothed - and divide by it. That removes glare, falloff and most of
the moire's brightness swing before any threshold sees the image.

**A typed screen profile of font size and display scaling.** Those do not
determine the grid: the measured advance is 10.75 px, not the 10.94 they
predict. The values have to come from Scintilla itself - see the next item.

### The screen profile, from Scintilla

`overlay.py` already knows the pane's window, and every value the grid needs
can be asked of it with integer-only messages, like the ones `plain_view.py`
already sends (no cross-process string buffers needed):

| value                    | message                                                     |
| ------------------------ | ----------------------------------------------------------- |
| pane size                | client rect (already printed)                               |
| cell advance, to 0.01 px | `SCI_POINTXFROMPOSITION` difference across 100 characters of one line |
| line height              | `SCI_TEXTHEIGHT`                                            |
| where text starts        | `SCI_GETMARGINWIDTHN` over the margins, plus `SCI_GETMARGINLEFT` |

Printed as one pasteable line beside the pane size, this makes the grid fully
determined up to the three things the flat homography cannot know: the
remaining bow and column wander, the baseline's offset within a row, and which
rows have ink.

**What it lets `calibrate.ts` shed.** Nearly all of its 571 lines and fifteen
tuned constants: `MIN_ADVANCE_RATIO`, `MAX_ADVANCE_RATIO`, `WIDTH_COARSE_STEP`,
`WIDTH_FINE_STEP`, `WIDTH_POLISH`, `PHASE_STEP`, `BOUNDARY_BAND`, `PHASE_BINS`,
`MIN_INK_COLUMNS`, `MIN_ROW_INK`, `MAX_ROW_INK_FRACTION`, `MIN_ROW_INK_SHARE`,
`MIN_DIGIT_HEIGHT`, `MAX_ROW_OVERHANG`, `PITCH_POLISH`, `ROW_PITCH_STEP`. The
gutter search in `margins.ts` goes too for marker-framed captures (it stays for
dragged corners). What remains:

- a bounded local refinement, a phase of at most +-0.3 cell per region, for the
  residual the flat homography leaves;
- a confidence check: how empty the gaps between cells are at the known grid.
  Low means the profile is stale or the capture is bad;
- the baseline offset, from the feet of the line numbers as now;
- the trim of rows with no ink.

**A stale profile.** The typed pane size currently overrides the camera's
answer outright. A window resized since typing silently distorts every
capture. Since the camera's answer is within 0.9% on every capture here,
disagreement over 2% should warn and fall back.

### Blur measurement

The homography says exactly where each arm's edges are, so the blur is a few
samples across a known edge: the 10-90% rise, in screen pixels. It is how the
blur numbers above were measured. What it is for is gating (below); using it
as a sharpening amount waits until there is evidence sharpening helps.

### Capture-time gating

- **Refuse** without all four markers.
- **Warn** below about 1.0 camera px per screen px ("closer"), and above a blur
  limit. That limit has to come from blur-versus-CER pairs, which is why step 1
  gives the `markers/` captures their text.
- **Warn** when the typed size and the camera disagree by more than 2%.
- **Auto-fire** on four markers, sharp, and stable across three frames. At
  ~210 ms per 1080p frame on a desktop, live detection needs a half-resolution
  preview on a phone.

### Multi-frame stacking

Last, as proposed. The one argument for it not in the original list: moire
phase moves with every small hand movement, so averaging registered frames is
one of the few real moire remedies, alongside resolution. The text checksum
(Part 2) is what guards it against averaging two different screens.

## Part 2: the display side

The four L's stay as they are. Nothing below requires changing them, and the
two items that would are marked.

**1. Block strips in the tab bar and status bar.** Not needed for distortion:
the pane's own top and bottom boundaries, dark chrome against white page, are
already full-length straight edges in every capture, and the boundary between
the grey gutter and the white text is a full-height vertical one. Worth it as a
**data channel**, and cheaper than it looks: the homography predicts each
block's centre, so no clock or sync pattern is needed. At up to 3 px of blur a
block wants to be about 10 screen px, which leaves room for about 80 per strip.
They need their own white tile, clear of the marker tiles so they never join a
marker's blob, and the marker photo gate re-run once they exist. Better than
mid-edge markers, which have nowhere to go when the window is maximised.

**2. Payload.** Minimum useful:

- top strip, about 65 bits: pane width and height, advance x 100, line height,
  text start, and a CRC-16. Buys the removal of the typed profile and of
  anything that can go stale.
- bottom strip, about 68 bits: first visible line (20), a CRC-32 of the visible
  text, and a CRC-16. The text checksum says whether a read is exactly right,
  and can correct one: try the alternatives for the few cells recognition was
  unsure of until it matches. It also guards stacking. The first visible line is
  redundant with the line numbers already read from the gutter; it is a
  cross-check only.

Reading the visible text needs `SCI_GETCHARAT` per character, which is integer
only, and is only worth doing when the view changes.

**3. Checkerboard saddle points.** Keep in reserve: the corners are not the
limit. Would change the L's.

**4. Grey step wedge.** Defer. The markers and page already give a black and a
white level, and local background division does most of the work. If wanted
later, it fits in the block strip.

**5. Markers scaled to the pane.** Skip: detection works at every distance
captured. Would change the L's.

**6. Identity from any three.** Identity is already there. A missing corner can
be recovered with no display change, where its two neighbours' edge lines
cross (top-right's vertical with bottom-left's horizontal). Extrapolating a
32 px edge over hundreds of pixels costs a few px, so it is a warned fallback.
Low priority while all four are found.

**7. Scrollbar thumb.** Skip: the line numbers in the gutter are exact.

Any strip geometry goes into `tools/marker-geometry.json`, with `overlay.py`'s
copy checked by the existing drift test, and its rationale into
`tools/README.md`.

## Build order

Each step names the number that should move.

1. **Measure first.** Done: the `markers/` captures have their text and are in
   the metrics run, and the table has `dens`, `blur`, `bow` and `wander`
   (`tests/fixtures/README.md`). Only the top and bottom boundaries are read
   for bow; the left and right have no reliable contrast with what is beside
   them. What the first run showed: across the eleven video captures, blur
   does not predict CER (1.3 px and 75%, 1.9 px and 30%), but wander does -
   every capture with wander 0.44 or more is at 75-99% CER, every one at 0.30
   or less is at 28-57%. The grid is what fails first.
2. **Resolution.** Ask `getUserMedia` for 4K, and confirm with a kept capture what the
   phone actually delivers. The biggest single lever, and upstream of
   everything else. Moves: camera px per screen px, blur, CER.
   In the app: it asks for 3840 x 2160, shows after freezing the frame it got
   and, with the pane size given, the camera px per screen px; a saved capture
   carries the pane size so it is measured unedited. The detector finds all
   eleven video captures at twice their size, at the first threshold, within
   about a pixel of before, in ~0.9 s for a full 4K frame on a desktop. Still
   to do on the phone: see what Safari grants, and whether the density and
   CER move. If it stops at 1080p, the next thing to try is the native camera
   through a file input, which hands over a full-resolution still.
3. **Screen profile and 2x output.** Done, with two changes from the plan.
   `overlay.py` prints `profile: 985 x 563, cell 10.750 x 23, text at 42`
   from integer-only Scintilla messages, or the size alone and the reason when
   the cell cannot be read. The start screen takes that line, or the size
   alone. A read then falls back to estimating the grid, and says why, when
   there is no grid in the profile, when the corners were placed by hand, when
   the camera puts the pane's proportions more than 2% from the profile's (a
   resized window), or when the text lines up best at a cell width more than
   3% from it (a changed font or zoom - a point size is about 7%).
   The changes: **no 2x output** - it took the estimator on the real photos
   from a median 41% CER to about 100%, so the fixed 1600 width stays, which
   is still one scale per pane - and **`calibrateCellPitch` stays** as the
   fallback rather than shrinking to a verifier. And the profile is not laid
   out rigidly: on the bowed photos that read worse than estimating, because
   the middle of the pane is squeezed by about 1%. The profile settles which
   spacing, how many rows and where text starts; the photograph sets the
   spacing within 3% of it.
   Measured: the rendered panes read at 0-1.1% CER on the profile path. The
   real photos have no printed profile yet; with a guessed one (10.75 x 23,
   text at 42) their median CER was 40.5%, level with estimating (41.4%), and
   the steadiest captures better (24.5% against 28.8%). Using the known
   aspect alone took the photos from 47.7% to 41.4%. Next: print the real
   profile on the machine, add it to the photo sidecars, and re-measure.
4. **Remove the bow.** Measure the four pane boundaries as curves in each shot
   (top and bottom against the chrome; left from the gutter-to-text boundary
   offset by the known margin width; right against the scrollbar) and warp
   through a patch bounded by those curves rather than by straight lines. That
   corrects whatever the cause - lens, stabilisation, or both - without having
   to name it. Moves: mid-edge deviation and column wander to about zero.
5. **Local background division.** Moves: the spread of blank page brightness,
   and CER.
6. **Blur measurement and capture gating**, auto-fire last.
7. **Bicubic resampling.** Small; any time.
8. **The data strip**, then checksum-guided correction.
9. **Multi-frame stacking**, guarded by the checksum.

## What else four known points make possible

- **Checking the pane is flat, per shot**, from its own boundaries, as step 4
  does - no calibration target required.
- **A staleness check on everything typed**, from the camera's own estimate.
- **Sub-pixel edges.** The detector fits thresholded pixel boundaries, which
  sit inside the true 50% edge by an amount that depends on blur and on which
  threshold won; the pane's 50% edge measured 0.0-0.5 px inside the fitted
  corners. Small next to the bow, and worth fixing only after it.
- **Recovering a missing corner** from its neighbours' edges.
- **Text correctness checked end to end**, once the checksum is on screen.
