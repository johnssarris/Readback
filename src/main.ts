import "./style.css";
import { CaptureController } from "./capture/CaptureController";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function boot() {
  const controller = new CaptureController(app);
  try {
    await controller.start();
  } catch (err) {
    app.innerHTML = `<p class="error">Camera access failed: ${(err as Error).message}</p>`;
  }
}

boot();
