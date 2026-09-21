# tools/

Helper scripts. The two Python scripts run on the Windows machine alongside
Notepad++, so their own comments describe only what they do to the editor.
Why each setting matters to Readback is recorded here instead.

## plain_view.py

Toggles Notepad++ into a uniform view: one font, black on white, no syntax
colors, no caret or line highlight, no extra margins. Each setting serves the
pipeline:

- **One font everywhere** (UDL Default style, UDL Number style, Global Styles >
  Line number margin): cells are matched against a glyph atlas rendered from
  Cascadia Mono, so the rendered glyph shapes have to match it. The pipeline
  also reads line numbers robustly in other gutter fonts (see
  `src/pipeline/lineNumbers.ts`), but a matching face is still the reference.
- **Grey gutter (`GUTTER`)**: `detectMargins` finds the gutter/text boundary
  from a step in background brightness. A white gutter leaves no step.
- **`TEXT_GAP = 0`**: margin padding is painted in the text background, so any
  gap would offset every column from the detected boundary.
- **Grayscale antialiasing**: ClearType's colored stroke fringes shift the
  luminance the matcher correlates against. The atlas is rendered with
  grayscale antialiasing too.
- **Bold/italic/underline off, single size**: the atlas has one weight and no
  decorations. Underline in particular puts ink in blank cells.
- **Caret, current-line highlight, change-history markers hidden**: each puts
  ink or background color into cells that should read as plain text or blank.
- **Word wrap on (`WRAP`)**: the pipeline finds rows from ink across the whole
  body and treats a numberless row as a continuation of the one above. With
  wrap off, long lines run off the right edge and are lost silently.
- **Display scaling**: point size maps to a different pixel size at different
  Windows scaling. Keep it at 100% so captures stay comparable.

## overlay.py

Draws four L-shaped corner markers whose corner points sit exactly on the
editor pane's corners, so the app can find the pane in a photo automatically.
The geometry contract (arm length, thickness, margin, which corner of each L
marks the pane corner) is in the script's header and must match the detector
in the app.

Status: standalone test version, run by hand while plain view is on. Not yet
launched by plain_view.py.
