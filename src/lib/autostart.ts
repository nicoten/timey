/**
 * Launch at login, wrapped so Settings deals in a boolean rather than plugin
 * calls. The operating system holds the state: nothing is stored in the
 * database, so the checkbox can never disagree with what actually happens.
 */

import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

export function autostartEnabled(): Promise<boolean> {
  return isEnabled();
}

export function setAutostart(on: boolean): Promise<void> {
  return on ? enable() : disable();
}

/**
 * True for the failure a plain browser produces, where there is no Tauri
 * runtime to ask. Anything else is a real error worth showing.
 */
export function autostartUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("window.__TAURI_INTERNALS__") || message.includes("not allowed");
}
