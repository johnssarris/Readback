import { estimateAspectRatio, warpPerspective, type Point } from "../pipeline/rectify";
import { detectMarkerQuad } from "../pipeline/markers";
import { detectMargins, type MarginBounds } from "../pipeline/margins";
import { calibrateCellPitch, type CellPitch } from "../pipeline/calibrate";
import { loadAtlasAssets } from "../pipeline/atlasLoader";
import { buildRows, rowsToText } from "../model/lineIndex";

const MARGIN_FRACTION = 0.12;

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
  private resultView: HTMLDivElement | null = null;

  private phase: Phase = "live";

  /** Whether the corners on screen came from the markers or from nowhere. */
  private fromMarkers = false;

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

    const controls = document.createElement("div");
    controls.className = "capture-controls";
    controls.append(this.freezeBtn, this.retakeBtn, this.readBtn);

    this.stage.append(this.video, this.frame, this.overlay, this.loupe);
    this.root.append(this.hint, this.stage, controls);

    window.addEventListener("resize", () => this.layoutHandles());
    this.setPhase("live");
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
    this.loupe.hidden = true;

    if (!adjusting) {
      this.hint.textContent = "Fill the frame with the window, hold steady, then freeze";
    } else if (this.fromMarkers) {
      this.hint.textContent = "Corners found. Nudge any that look wrong, then read";
    } else {
      this.hint.textContent = "No corner markers found. Drag each corner onto the pane";
    }
  }

  /** Takes the still everything from here on refers to. */
  private freeze(): void {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (width === 0 || height === 0) return;

    this.frame.width = width;
    this.frame.height = height;
    const ctx = this.frame.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, 0);

    // The markers, if they are in the shot, know where the pane is better than
    // a fingertip does. Failing that, a box to drag into place.
    const quad = detectMarkerQuad(ctx.getImageData(0, 0, width, height));
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
    const srcCorners = CORNER_ORDER.map((c) => this.points[c]);
    const aspect = estimateAspectRatio(srcCorners);

    const destWidth = 1600;
    const destHeight = Math.round(destWidth / aspect);

    const rectified = warpPerspective(this.frame, this.frame.width, this.frame.height, srcCorners, destWidth, destHeight);
    this.showResult(rectified);
  }

  private showResult(canvas: HTMLCanvasElement): void {
    this.stop();

    const pipelineResult = this.runDebugPipeline(canvas);

    this.resultView = document.createElement("div");
    this.resultView.className = "result-view";

    canvas.className = "result-canvas";

    const info = document.createElement("pre");
    info.className = "debug-info";
    info.textContent = pipelineResult.summary;

    const recognized = document.createElement("pre");
    recognized.className = "recognized-text";
    recognized.textContent = "Loading glyph atlas…";

    const retakeBtn = button("Retake", "retake-btn", () => this.restart());

    this.resultView.append(canvas, info, recognized, retakeBtn);
    this.root.innerHTML = "";
    this.root.appendChild(this.resultView);

    if (pipelineResult.margins && pipelineResult.pitch) {
      this.runRecognition(canvas, pipelineResult.margins, pipelineResult.pitch, recognized);
    } else {
      recognized.textContent = "Recognition skipped: margin/calibration detection failed.";
    }
  }

  /**
   * M2 debug pass: runs margin detection + self-calibration on the rectified capture and
   * draws the detected bounds/grid directly onto the result canvas, so alignment can be
   * checked visually against a real photo. Returns a short text summary plus the detected
   * bounds/pitch for the M3 recognition pass below.
   */
  private runDebugPipeline(canvas: HTMLCanvasElement): {
    summary: string;
    margins: MarginBounds | null;
    pitch: CellPitch | null;
  } {
    const ctx = canvas.getContext("2d")!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const lines: string[] = [];
    let margins: MarginBounds | null = null;
    let pitch: CellPitch | null = null;

    try {
      margins = detectMargins(imageData);
      lines.push(`body: y ${margins.bodyTopY}–${margins.bodyBottomY}`);
      lines.push(`gutter edge: x=${margins.gutterRightEdgeX}, text right: x=${margins.textAreaRightX}`);

      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#f97316";
      ctx.beginPath();
      ctx.moveTo(0, margins.bodyTopY);
      ctx.lineTo(canvas.width, margins.bodyTopY);
      ctx.moveTo(0, margins.bodyBottomY);
      ctx.lineTo(canvas.width, margins.bodyBottomY);
      ctx.stroke();

      ctx.strokeStyle = "#22d3ee";
      ctx.beginPath();
      ctx.moveTo(margins.gutterRightEdgeX, margins.bodyTopY);
      ctx.lineTo(margins.gutterRightEdgeX, margins.bodyBottomY);
      ctx.moveTo(margins.textAreaRightX, margins.bodyTopY);
      ctx.lineTo(margins.textAreaRightX, margins.bodyBottomY);
      ctx.stroke();

      pitch = calibrateCellPitch(imageData, margins);
      lines.push(
        `cell pitch: ${pitch.widthPx.toFixed(1)} x ${pitch.heightPx.toFixed(1)} px, rows detected: ${pitch.rowYCenters.length}`
      );

      if (Number.isFinite(pitch.widthPx) && Number.isFinite(pitch.heightPx) && pitch.rowYCenters.length > 0) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(56, 189, 248, 0.5)";
        ctx.beginPath();
        for (const yCenter of pitch.rowYCenters) {
          const top = yCenter - pitch.heightPx / 2;
          ctx.moveTo(pitch.columnOriginX, top);
          ctx.lineTo(margins.textAreaRightX, top);
        }
        for (let x = pitch.columnOriginX; x < margins.textAreaRightX; x += pitch.widthPx) {
          ctx.moveTo(x, margins.bodyTopY);
          ctx.lineTo(x, margins.bodyBottomY);
        }
        ctx.stroke();
      } else {
        lines.push("grid not drawn: calibration did not resolve a usable cell pitch");
        pitch = null;
      }
      ctx.restore();
    } catch (err) {
      lines.push(`pipeline error: ${(err as Error).message}`);
      margins = null;
      pitch = null;
    }
    return { summary: lines.join("\n"), margins, pitch };
  }

  /**
   * M3: loads the glyph atlas (if generated — see public/tools/atlas-generator.html) and runs
   * full recognition, rendering the reconstructed text with flagged cells highlighted.
   */
  private async runRecognition(
    canvas: HTMLCanvasElement,
    margins: MarginBounds,
    pitch: CellPitch,
    target: HTMLElement
  ): Promise<void> {
    const atlas = await loadAtlasAssets();
    if (!atlas) {
      target.textContent =
        "No glyph atlas found at /atlas/. Generate one with npm run atlas and place atlas.png + atlas-manifest.json under public/atlas/.";
      return;
    }

    const ctx = canvas.getContext("2d")!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rows = buildRows(imageData, margins, pitch, atlas);

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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
