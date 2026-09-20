import { estimateAspectRatio, warpPerspective, type Point } from "../pipeline/rectify";
import { detectMargins, type MarginBounds } from "../pipeline/margins";
import { calibrateCellPitch, type CellPitch } from "../pipeline/calibrate";
import { loadAtlasAssets } from "../pipeline/atlasLoader";
import { buildRows, rowsToText } from "../model/lineIndex";

const HANDLE_SIZE = 28;
const MARGIN_FRACTION = 0.12;

type Corner = "tl" | "tr" | "br" | "bl";
const CORNER_ORDER: Corner[] = ["tl", "tr", "br", "bl"];

export class CaptureController {
  private root: HTMLElement;
  private video: HTMLVideoElement;
  private overlay: HTMLDivElement;
  private handles: Record<Corner, HTMLDivElement> = {} as any;
  private polygon: SVGPolygonElement;
  private stage: HTMLDivElement;
  private shutterBtn: HTMLButtonElement;
  private resultView: HTMLDivElement | null = null;

  /** Corner positions in CSS pixels, relative to `stage`. */
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
    this.video.className = "capture-video";
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "capture-overlay-svg");
    this.polygon = document.createElementNS(svgNS, "polygon") as SVGPolygonElement;
    this.polygon.setAttribute("class", "capture-quad");
    svg.appendChild(this.polygon);

    this.overlay = document.createElement("div");
    this.overlay.className = "capture-overlay";
    this.overlay.appendChild(svg);

    for (const corner of CORNER_ORDER) {
      const handle = document.createElement("div");
      handle.className = `capture-handle capture-handle-${corner}`;
      handle.dataset.corner = corner;
      this.overlay.appendChild(handle);
      this.handles[corner] = handle;
      this.attachDrag(handle, corner);
    }

    this.shutterBtn = document.createElement("button");
    this.shutterBtn.className = "shutter-btn";
    this.shutterBtn.textContent = "Capture";
    this.shutterBtn.addEventListener("click", () => this.capture());

    const hint = document.createElement("p");
    hint.className = "capture-hint";
    hint.textContent = "Align the corners to the outer edge of the Notepad++ window";

    this.stage.appendChild(this.video);
    this.stage.appendChild(this.overlay);
    this.root.appendChild(hint);
    this.root.appendChild(this.stage);
    this.root.appendChild(this.shutterBtn);

    window.addEventListener("resize", () => this.layoutHandles());
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
    this.resetCornersToDefault();
    this.layoutHandles();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private resetCornersToDefault(): void {
    const rect = this.stage.getBoundingClientRect();
    const mx = rect.width * MARGIN_FRACTION;
    const my = rect.height * MARGIN_FRACTION;
    this.points = {
      tl: { x: mx, y: my },
      tr: { x: rect.width - mx, y: my },
      br: { x: rect.width - mx, y: rect.height - my },
      bl: { x: mx, y: rect.height - my },
    };
  }

  private attachDrag(handle: HTMLDivElement, corner: Corner): void {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);

      const move = (ev: PointerEvent) => {
        const rect = this.stage.getBoundingClientRect();
        const x = clamp(ev.clientX - rect.left, 0, rect.width);
        const y = clamp(ev.clientY - rect.top, 0, rect.height);
        this.points[corner] = { x, y };
        this.layoutHandles();
      };

      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  private layoutHandles(): void {
    for (const corner of CORNER_ORDER) {
      const p = this.points[corner];
      const handle = this.handles[corner];
      handle.style.left = `${p.x - HANDLE_SIZE / 2}px`;
      handle.style.top = `${p.y - HANDLE_SIZE / 2}px`;
    }
    const orderedPoints = CORNER_ORDER.map((c) => this.points[c]);
    this.polygon.setAttribute("points", orderedPoints.map((p) => `${p.x},${p.y}`).join(" "));
  }

  /** Maps a stage-space (CSS pixel) point into native video-frame pixel coordinates. */
  private toVideoSpace(p: Point): Point {
    const rect = this.stage.getBoundingClientRect();
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const renderedW = vw * scale;
    const renderedH = vh * scale;
    const offsetX = (rect.width - renderedW) / 2;
    const offsetY = (rect.height - renderedH) / 2;
    return {
      x: (p.x - offsetX) / scale,
      y: (p.y - offsetY) / scale,
    };
  }

  private capture(): void {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;

    const srcCorners = CORNER_ORDER.map((c) => this.toVideoSpace(this.points[c]));
    const aspect = estimateAspectRatio(srcCorners);

    const destWidth = 1600;
    const destHeight = Math.round(destWidth / aspect);

    const rectified = warpPerspective(this.video, vw, vh, srcCorners, destWidth, destHeight);
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

    const retakeBtn = document.createElement("button");
    retakeBtn.className = "retake-btn";
    retakeBtn.textContent = "Retake";
    retakeBtn.addEventListener("click", () => this.retake());

    this.resultView.appendChild(canvas);
    this.resultView.appendChild(info);
    this.resultView.appendChild(recognized);
    this.resultView.appendChild(retakeBtn);

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
          ctx.moveTo(margins.textAreaLeftX, top);
          ctx.lineTo(margins.textAreaRightX, top);
        }
        for (let x = margins.textAreaLeftX; x < margins.textAreaRightX; x += pitch.widthPx) {
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
        "No glyph atlas found at /atlas/. Generate one via /tools/atlas-generator.html and place atlas.png + atlas-manifest.json under public/atlas/.";
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

  private retake(): void {
    const root = this.root;
    const controller = new CaptureController(root);
    controller.start();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
