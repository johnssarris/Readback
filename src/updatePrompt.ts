import { registerSW } from "virtual:pwa-register";

/** How often a running app re-checks the server for a new deploy. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Coming back to the app checks again, but not more often than this. */
const RESUME_CHECK_MIN_MS = 60 * 1000;

/**
 * How long to wait, after Update is tapped, for the new version to take over
 * before reloading anyway. Normally the service worker's controllerchange
 * reloads the page well within this; a home-screen app on iOS does not always
 * deliver it.
 */
const RELOAD_FALLBACK_MS = 4000;

/**
 * Registers the service worker in "prompt" mode: a new deploy is downloaded in
 * the background but never activated behind the user's back — they get a toast
 * and decide when to reload. Swapping code mid-capture would otherwise throw
 * away whatever is on screen.
 *
 * A version already waiting when the app opens is announced too: workbox
 * reports it as waiting as soon as the worker registers.
 */
export function setupUpdatePrompt(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      showToast(updateSW);
    },
    onRegisteredSW(_url, registered) {
      if (!registered) return;

      // Home-screen apps can stay "open" for days, so poll, and also check
      // whenever the app comes back to the foreground - including from the
      // back-forward cache, which fires pageshow rather than a fresh load.
      setInterval(() => void registered.update(), UPDATE_CHECK_INTERVAL_MS);

      let lastCheck = 0;
      const resumed = () => {
        // A version the user put off with "Later" is still waiting; say so again.
        if (registered.waiting) showToast(updateSW);
        const now = Date.now();
        if (now - lastCheck < RESUME_CHECK_MIN_MS) return;
        lastCheck = now;
        void registered.update();
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") resumed();
      });
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) resumed();
      });
    },
  });
}

function showToast(updateSW: (reload?: boolean) => Promise<void>): void {
  if (document.querySelector(".update-toast")) return;

  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.setAttribute("role", "status");

  const text = document.createElement("span");
  text.textContent = "A new version is available.";

  const update = document.createElement("button");
  update.className = "update-toast-accept";
  update.textContent = "Update";
  update.addEventListener("click", () => {
    update.disabled = true;
    update.textContent = "Updating…";
    void updateSW(true);

    // Normally the new worker takes control and the page reloads itself. If
    // that never arrives, reload anyway: the new worker is active by then and
    // serves the reload, and if it somehow is not, it is still waiting and the
    // reloaded page offers it again.
    setTimeout(() => window.location.reload(), RELOAD_FALLBACK_MS);
  });

  const later = document.createElement("button");
  later.className = "update-toast-dismiss";
  later.textContent = "Later";
  later.addEventListener("click", () => toast.remove());

  toast.append(text, update, later);
  document.body.appendChild(toast);
}
