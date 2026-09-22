import {
  assumedIntrinsics,
  cameraPxPerScreenPx,
  estimatePaneAspect,
  normalizeQuad,
  rectifyFrame,
  type OutputSizing,
  type PaneAspect,
  type Point,
} from "../pipeline/rectify";
import { loadPaneSize } from "../settings";
import { VERSION_LABEL } from "../version";
import { inspectMarkers, type MarkerReport } from "../pipeline/markers";
import { saveCapture } from "./saveCapture";
import type { Framing } from "../pipeline/margins";
import { analyzeCapture, RECTIFIED_SIZING } from "../pipeline/analyze";
import { loadAtlasAssets } from "../pipeline/atlasLoader";
import { rowsToText, type LineRow } from "../model/lineIndex";
import { drawDebugOverlay } from "./debugOverlay";

const MARGIN_FRACTION = 0.12;

/**
 * The frame asked of the camera: 4K, the most a phone's browser offers.
 *
 * At 1080p a pane filling the shot got fewer camera pixels than it has screen
 * pixels - 0.77 to 0.97 of one per screen pixel across the saved captures -
 * while a glyph's strokes are one or two screen pixels wide. It is asked for as
 * ideal, not exact: a camera that cannot do it hands over the nearest it can,
 * and what it actually gave is shown after freezing and kept with a saved
 * capture.
 */
const REQUESTED_FRAME = { width: 3840, height: 2160 };

/** Side of the loupe, and how much it magnifies. */
const LOUPE_SIZE = 132;
const LOUPE_ZOOM = 3;

type Corner = "tl" | "tr" | "br" | "bl";
const CORNER_ORDER: Corner[] = ["tl", "tr", "br", "bl"];

type Phase = "live" | "adjust";

/**
 * Framing a capture in two steps: hold the shot still, then say where its
 * corners are.
 *
 * Placing corners on a live preview means the frame that gets read is not the
 * frame they were placed on - the hand moves between the last adjustment and
 * the shutter, and the quad ends up describing where the window used to be.
 * Freezing first makes the two the same frame by construction.
 */
export class CaptureController {
  private root: HTMLElement;
  private video: HTMLVideoElement;
  private frame: HTMLCanvasElement;
  private overlay: HTMLDivElement;
  private handles: Record<Corner, HTMLDivElement> = {} as any;
  private polygon: SVGPolygonElement;
  private stage: HTMLDivElement;
  private loupe: HTMLCanvasElement;
  private hint: HTMLParagraphElement;
  private freezeBtn: HTMLButtonElement;
  private readBtn: HTMLButtonElement;
  private retakeBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private resultView: HTMLDivElement | null = null;

  private phase: Phase = "live";

  /** Whether the corners on screen came from the markers or from nowhere. */
  private fromMarkers = false;

  /** What the detector made of the frozen frame, for the hint and for saving. */
  private report: MarkerReport | null = null;

  /** Corner positions in frozen-frame pixels, which is what the warp needs. */
  private points: Record<Corner, Point> = {
    tl: { x: 0, y: 0 },
    tr: { x: 0, y: 0 },
    br: { x: 0, y: 0 },
    bl: { x: 0, y: 0 },
  };

  private stream: MediaStream | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = "";

    this.stage = document.createElement("div");
    this.stage.className = "capture-stage";

    this.video = document.createElement("video");
    this.video.className = "capture-view";
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    this.frame = document.createElement("canvas");
    this.frame.className = "capture-view";
    this.frame.hidden = true;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "capture-overlay-svg");
    this.polygon = document.createElementNS(svgNS, "polygon") as SVGPolygonElement;
    this.polygon.setAttribute("class", "capture-quad");
    svg.appendChild(this.polygon);

    this.overlay = document.createElement("div");
    this.overlay.className = "capture-overlay";
    this.overlay.hidden = true;
    this.overlay.appendChild(svg);

    for (const corner of CORNER_ORDER) {
      const handle = document.createElement("div");
      handle.className = `capture-handle capture-handle-${corner}`;
      handle.dataset.corner = corner;
      this.overlay.appendChild(handle);
      this.handles[corner] = handle;
      this.attachDrag(handle, corner);
    }

    this.loupe = document.createElement("canvas");
    this.loupe.className = "capture-loupe";
    this.loupe.width = LOUPE_SIZE;
    this.loupe.height = LOUPE_SIZE;
    this.loupe.hidden = true;

    this.hint = document.createElement("p");
    this.hint.className = "capture-hint";

    this.freezeBtn = button("Freeze", "shutter-btn", () => this.freeze());
    this.readBtn = button("Read", "shutter-btn", () => this.read());
    this.retakeBtn = button("Retake", "shutter-btn secondary", () => this.retake());
    this.saveBtn = button("Save", "shutter-btn secondary", () => this.save());

    const controls = document.createElement("div");
    controls.className = "capture-controls";
    controls.append(this.freezeBtn, this.retakeBtn, this.saveBtn, this.readBtn);

    this.stage.append(this.video, this.frame, this.overlay, this.loupe);
    this.root.append(this.hint, this.stage, controls);

    window.addEventListener("resize", () => this.layoutHandles());
    this.setPhase("live");
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: REQUESTED_FRAME.width },
        height: { ideal: REQUESTED_FRAME.height },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await new Promise<void>((resolve) => {
      this.video.onloadedmetadata = () => resolve();
    });
    await this.video.play().catch(() => undefined);
    this.setPhase("live");
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    const adjusting = phase === "adjust";

    this.video.hidden = adjusting;
    this.frame.hidden = !adjusting;
    this.overlay.hidden = !adjusting;
    this.freezeBtn.hidden = adjusting;
    this.readBtn.hidden = !adjusting;
    this.retakeBtn.hidden = !adjusting;
    this.saveBtn.hidden = !adjusting;
    this.loupe.hidden = true;

    if (!adjusting) {
      this.hint.textContent = "Fill the frame with the window, hold steady, then freeze";
    } else if (this.fromMarkers) {
      this.hint.textContent = `Corners found. Nudge any that look wrong, then read — ${this.verdict()} · ${this.sampling()}`;
    } else {
      this.hint.textContent = `No corner markers found. Drag each corner onto the pane — ${this.verdict()} · ${this.sampling()}`;
    }
  }

  /**
   * What the camera actually gave, and what that came to on the pane.
   *
   * The frame is whatever the camera settled on, which need not be what was
   * asked for; with the pane's size known, the corners also say how many
   * camera pixels each screen pixel got - below 1, fewer than the screen has.
   */
  private sampling(): string {
    const frame = `${this.frame.width}×${this.frame.height}`;
    const pane = loadPaneSize();
    if (!pane || !this.fromMarkers) return frame;
    const density = cameraPxPerScreenPx(CORNER_ORDER.map((c) => this.points[c]), pane);
    return `${frame}, ${density.toFixed(2)} camera px per screen px`;
  }

  /**
   * The detector's own account of the frame, in a line.
   *
   * A saved capture carries the full report, but the answer to "why didn't it
   * find them this time" is usually one number - how many marker-shaped things
   * were in the frame and how they fell across the four corners - and it is
   * worth having without unzipping anything.
   */
  private verdict(): string {
    const report = this.report;
    if (!report) return "no reading";

    const counts = CORNER_ORDER.map((corner) => report.candidates[corner]);
    const total = counts.reduce((a, b) => a + b, 0);
    switch (report.outcome) {
      case "found":
        return `${total} marker-shaped, ${report.ms}ms`;
      case "no-candidates":
        return `nothing marker-shaped in ${report.blobs} dark shapes`;
      case "corners-missing":
        return `${total} marker-shaped, none facing ${CORNER_ORDER.filter((c) => report.candidates[c] === 0).join("/")}`;
      case "no-plausible-quad":
        return `${total} marker-shaped, no four of them a pane (${report.quadsTried} tried)`;
    }
  }

  /**
   * Takes the still everything from here on refers to.
   *
   * The still is shown at once and the markers looked for after, since at 4K
   * looking takes long enough that a preview still moving would look like a
   * shutter that had not fired.
   */
  private async freeze(): Promise<void> {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (width === 0 || height === 0 || this.freezeBtn.disabled) return;

    this.frame.width = width;
    this.frame.height = height;
    const ctx = this.frame.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, 0);

    this.video.hidden = true;
    this.frame.hidden = false;
    this.freezeBtn.disabled = true;
    this.hint.textContent = "Looking for the corner markers…";
    await nextPaint();
    this.freezeBtn.disabled = false;

    // The markers, if they are in the shot, know where the pane is better than
    // a fingertip does. Failing that, a box to drag into place.
    this.report = inspectMarkers(ctx.getImageData(0, 0, width, height));
    const quad = this.report.quad;
    this.fromMarkers = quad !== null;

    if (quad) {
      const [tl, tr, br, bl] = quad.corners;
      this.points = { tl, tr, br, bl };
    } else {
      const mx = width * MARGIN_FRACTION;
      const my = height * MARGIN_FRACTION;
      this.points = {
        tl: { x: mx, y: my },
        tr: { x: width - mx, y: my },
        br: { x: width - mx, y: height - my },
        bl: { x: mx, y: height - my },
      };
    }

    this.setPhase("adjust");
    this.layoutHandles();
  }

  private retake(): void {
    this.setPhase("live");
  }

  /**
   * Saves the frozen frame and everything known about it, as a fixture.
   *
   * The capture that goes wrong is the one nobody can reproduce: it happened on
   * a phone, against a screen, in a room none of the test images came from. So
   * the frame leaves with the corners it was read at and the detector's account
   * of it, in the layout tests/fixtures uses, ready to become a permanent case.
   */
  private save(): void {
    if (this.phase !== "adjust" || !this.report) return;

    const label = this.saveBtn.textContent;
    this.saveBtn.disabled = true;
    this.saveBtn.textContent = "Saving…";

    const quad = normalizeQuad(CORNER_ORDER.map((c) => this.points[c]));
    saveCapture({
      frame: this.frame,
      corners: this.points,
      aspect: quad ? this.paneAspect(quad) : null,
      fromMarkers: this.fromMarkers,
      report: this.report,
      track: this.stream?.getVideoTracks()[0]?.getSettings() ?? null,
      paneSize: loadPaneSize(),
    })
      .catch((error) => {
        this.hint.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        this.saveBtn.disabled = false;
        this.saveBtn.textContent = label;
      });
  }

  /**
   * How the frozen frame is laid out inside the stage.
   *
   * The canvas is letterboxed to fit (object-fit: contain), so a point on it is
   * somewhere else on screen, and the two have to be converted between for
   * every drag and every magnified crop.
   */
  private fit(): { scale: number; offsetX: number; offsetY: number } {
    const rect = this.stage.getBoundingClientRect();
    const scale = Math.min(rect.width / this.frame.width, rect.height / this.frame.height);
    return {
      scale,
      offsetX: (rect.width - this.frame.width * scale) / 2,
      offsetY: (rect.height - this.frame.height * scale) / 2,
    };
  }

  private toStage(p: Point): Point {
    const { scale, offsetX, offsetY } = this.fit();
    return { x: p.x * scale + offsetX, y: p.y * scale + offsetY };
  }

  private toFrame(p: Point): Point {
    const { scale, offsetX, offsetY } = this.fit();
    return {
      x: clamp((p.x - offsetX) / scale, 0, this.frame.width),
      y: clamp((p.y - offsetY) / scale, 0, this.frame.height),
    };
  }

  private attachDrag(handle: HTMLDivElement, corner: Corner): void {
    handle.addEventListener("pointerdown", (e) => {
      if (this.phase !== "adjust") return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      this.showLoupe(this.points[corner]);

      const move = (ev: PointerEvent) => {
        const rect = this.stage.getBoundingClientRect();
        this.points[corner] = this.toFrame({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
        this.layoutHandles();
        this.showLoupe(this.points[corner]);
      };

      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        this.loupe.hidden = true;
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  /**
   * Magnified view of what is under the corner being dragged.
   *
   * A fingertip covers far more of the screen than the corner it is placing, so
   * the loupe sits in a corner of the stage well away from the hand rather than
   * following the finger, where it would be underneath it or off the top edge.
   */
  private showLoupe(at: Point): void {
    const ctx = this.loupe.getContext("2d")!;
    const span = LOUPE_SIZE / LOUPE_ZOOM;

    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.frame, at.x - span / 2, at.y - span / 2, span, span, 0, 0, LOUPE_SIZE, LOUPE_SIZE);

    // Crosshair on the exact point, since the loupe is what it is being placed by.
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE_SIZE / 2, 0);
    ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
    ctx.moveTo(0, LOUPE_SIZE / 2);
    ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
    ctx.stroke();

    const stagePoint = this.toStage(at);
    const rect = this.stage.getBoundingClientRect();
    this.loupe.classList.toggle("right", stagePoint.x < rect.width / 2);
    this.loupe.hidden = false;
  }

  private layoutHandles(): void {
    if (this.phase !== "adjust") return;

    for (const corner of CORNER_ORDER) {
      const p = this.toStage(this.points[corner]);
      const handle = this.handles[corner];
      handle.style.left = `${p.x}px`;
      handle.style.top = `${p.y}px`;
    }
    this.polygon.setAttribute(
      "points",
      CORNER_ORDER.map((c) => {
        const p = this.toStage(this.points[c]);
        return `${p.x},${p.y}`;
      }).join(" ")
    );
  }

  private read(): void {
    const ctx = this.frame.getContext("2d", { willReadFrequently: true })!;
    const source = ctx.getImageData(0, 0, this.frame.width, this.frame.height);
    const known = loadPaneSize();
    const sizing: OutputSizing =
      RECTIFIED_SIZING.kind === "source" && known ? { ...RECTIFIED_SIZING, paneSize: known } : RECTIFIED_SIZING;

    const rectified = rectifyFrame(
      source,
      CORNER_ORDER.map((c) => this.points[c]),
      {
        sizing,
        intrinsics: assumedIntrinsics(this.frame.width, this.frame.height),
        knownAspect: known ? known.width / known.height : undefined,
      }
    );
    if (!rectified) {
      this.hint.textContent = "Those corners don't make a pane. Drag each one onto a corner of the window, then read.";
      return;
    }

    const image = new ImageData(rectified.data as Uint8ClampedArray<ArrayBuffer>, rectified.width, rectified.height);
    const note = `frame ${this.frame.width} x ${this.frame.height}, rectified ${rectified.width} x ${rectified.height}, aspect ${rectified.aspect.aspect.toFixed(3)} (${rectified.aspect.method})${rectified.size.clamped ? ", size capped" : ""}`;
    void this.showResult(image, this.fromMarkers ? "pane" : "window", `${VERSION_LABEL}\n${note}`);
  }

  /** The pane's proportions: as given on the start screen, or else from the corners and the camera. */
  private paneAspect(corners: Point[]): PaneAspect {
    const known = loadPaneSize();
    return estimatePaneAspect(corners, {
      knownAspect: known ? known.width / known.height : undefined,
      intrinsics: assumedIntrinsics(this.frame.width, this.frame.height),
    });
  }

  /**
   * Reads the rectified capture and shows what was read.
   *
   * The pixels are read once, as they came out of the warp, and nothing is ever
   * drawn on them: the grid and margins go on a transparent canvas laid over
   * the one showing the capture, so looking at the result cannot change it.
   */
  private async showResult(rectified: ImageData, framing: Framing, note: string): Promise<void> {
    this.stop();

    this.resultView = document.createElement("div");
    this.resultView.className = "result-view";

    const stack = document.createElement("div");
    stack.className = "result-stack";

    const canvas = document.createElement("canvas");
    canvas.className = "result-canvas";
    canvas.width = rectified.width;
    canvas.height = rectified.height;
    canvas.getContext("2d")!.putImageData(rectified, 0, 0);

    const overlay = document.createElement("canvas");
    overlay.className = "result-overlay";
    overlay.width = rectified.width;
    overlay.height = rectified.height;

    stack.append(canvas, overlay);

    const info = document.createElement("pre");
    info.className = "debug-info";
    info.textContent = "Reading…";

    const recognized = document.createElement("pre");
    recognized.className = "recognized-text";
    recognized.textContent = "Loading glyph atlas…";

    const retakeBtn = button("Retake", "retake-btn", () => this.restart());

    this.resultView.append(stack, info, recognized, retakeBtn);
    this.root.innerHTML = "";
    this.root.appendChild(this.resultView);

    const atlas = await loadAtlasAssets();
    const analysis = analyzeCapture(rectified, framing, atlas);

    info.textContent = [note, ...analysis.summary].join("\n");
    if (analysis.margins) {
      drawDebugOverlay(overlay.getContext("2d")!, rectified, analysis.margins, analysis.pitch);
    }

    if (!analysis.margins || !analysis.pitch) {
      recognized.textContent = "Recognition skipped: margin/calibration detection failed.";
    } else if (!atlas) {
      recognized.textContent =
        "No glyph atlas found at /atlas/. Generate one with npm run atlas and place atlas.png + atlas-manifest.json under public/atlas/.";
    } else {
      this.renderRows(analysis.rows ?? [], recognized);
    }
  }

  /** The recognized text, a line per row, with the cells it was unsure of marked. */
  private renderRows(rows: LineRow[], target: HTMLElement): void {
    target.innerHTML = "";
    for (const row of rows) {
      const lineEl = document.createElement("div");
      lineEl.className = "recognized-line";

      const lineNo = document.createElement("span");
      lineNo.className = "recognized-line-number";
      lineNo.textContent = row.isWrappedContinuation ? "···" : String(row.lineNumber);
      lineEl.appendChild(lineNo);

      for (const cell of row.cells) {
        const span = document.createElement("span");
        span.textContent = cell.char === "" ? " " : cell.char;
        if (cell.flagged) span.className = "cell-flagged";
        lineEl.appendChild(span);
      }
      target.appendChild(lineEl);
    }

    if (rows.length === 0) {
      target.textContent = "No rows recognized.";
    }

    console.log("Recognized text:\n" + rowsToText(rows));
  }

  private restart(): void {
    const controller = new CaptureController(this.root);
    controller.start();
  }
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = className;
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

/** Resolves once the browser has painted what was just put on screen. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
