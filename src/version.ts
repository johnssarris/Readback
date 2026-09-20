declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

/** Short commit the bundle was built from, or "dev" outside a git checkout. */
export const APP_VERSION = __APP_VERSION__;

/** Build date, ISO yyyy-mm-dd. */
export const BUILD_DATE = __BUILD_DATE__;

/** What the version badge shows, e.g. "2026-09-20 · ef667df". */
export const VERSION_LABEL = `${BUILD_DATE} · ${APP_VERSION}`;
