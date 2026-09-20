import { registerSW } from "virtual:pwa-register";

/** How often a running app re-checks the server for a new deploy. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Registers the service worker in "prompt" mode: a new deploy is downloaded in
 * the background but never activated behind the user's back — they get a toast
 * and decide when to reload. Swapping code mid-capture would otherwise throw
 * away whatever is on screen.
 */
export function setupUpdatePrompt(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      showToast(updateSW);
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // Home-screen apps can stay "open" for days, so poll, and also check
      // whenever the app comes back to the foreground.
      setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void registration.update();
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
  });

  const later = document.createElement("button");
  later.className = "update-toast-dismiss";
  later.textContent = "Later";
  later.addEventListener("click", () => toast.remove());

  toast.append(text, update, later);
  document.body.appendChild(toast);
}
