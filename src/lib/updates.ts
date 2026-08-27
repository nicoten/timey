/**
 * Auto-update, wrapped so the rest of the app deals in plain state rather than
 * plugin events.
 *
 * Nothing installs without being asked for: the launch check only reports that
 * a version exists, and the download starts when someone chooses it.
 */

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export interface AvailableUpdate {
  version: string;
  notes?: string;
  /** Kept so install can reuse the same handle the check produced. */
  install: (onProgress: (percent: number | null) => void) => Promise<void>;
}

export async function currentVersion(): Promise<string> {
  return getVersion();
}

/**
 * `null` means there is nothing newer. Throws only on a real failure, so a
 * silent launch check can swallow it while a manual check can show it.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await check();
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body ?? undefined,
    install: async (onProgress) => {
      let contentLength = 0;
      let downloaded = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            onProgress(contentLength > 0 ? 0 : null);
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            onProgress(contentLength > 0 ? Math.min(downloaded / contentLength, 1) : null);
            break;
          case "Finished":
            onProgress(1);
            break;
        }
      });

      // macOS needs an explicit restart once the bundle is swapped.
      await relaunch();
    },
  };
}

/**
 * True when the updater cannot work here at all — a browser during `pnpm dev`,
 * where there is no Tauri bridge. Used to stay quiet instead of erroring.
 */
export function updaterUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("window.__TAURI_INTERNALS__") || message.includes("not allowed");
}
