import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { todayIso } from "./dates";

/**
 * Today's date, kept current for a page that never reloads.
 *
 * The popover is hidden rather than closed, so the webview mounted once and
 * lives for as long as the app runs — days or weeks. A date read during render
 * would freeze at whatever day the app was launched. Showing the popover gives
 * it focus, so that is the moment to look at the clock again; the DOM focus and
 * visibility events cover the same moment when the window API is unavailable.
 */
export function useToday(): string {
  const [today, setToday] = useState(todayIso);

  useEffect(() => {
    // Same-value updates are dropped by React, so this is free on ordinary days.
    const refresh = () => setToday(todayIso());

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) refresh();
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return today;
}
