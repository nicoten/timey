import { useCallback, useEffect, useRef, useState } from "react";

import type { UpdateState } from "./updateState";
import { type AvailableUpdate, checkForUpdate, currentVersion, updaterUnavailable } from "./updates";

export interface Updates {
  state: UpdateState;
  /** `null` until the app version is known, or in a plain browser. */
  version: string | null;
  check: () => void;
  install: () => void;
  dismiss: () => void;
}

export function useUpdates(): Updates {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [version, setVersion] = useState<string | null>(null);
  const available = useRef<AvailableUpdate | null>(null);

  useEffect(() => {
    currentVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const run = useCallback(async (manual: boolean) => {
    setState({ status: "checking" });
    try {
      const found = await checkForUpdate();
      available.current = found;
      setState(
        found
          ? { status: "available", version: found.version, notes: found.notes }
          : { status: "upToDate" },
      );
    } catch (error) {
      if (updaterUnavailable(error)) {
        setState({ status: "unsupported" });
        return;
      }
      // A failed check on launch stays silent; an explicit check reports.
      setState(
        manual
          ? { status: "error", message: error instanceof Error ? error.message : String(error) }
          : { status: "idle" },
      );
    }
  }, []);

  // One quiet check per launch.
  useEffect(() => {
    void run(false);
  }, [run]);

  const install = useCallback(() => {
    const update = available.current;
    if (!update) return;

    setState({ status: "downloading", version: update.version, percent: null });
    void (async () => {
      try {
        await update.install((percent) => {
          setState(
            percent !== null && percent >= 1
              ? { status: "installing", version: update.version }
              : { status: "downloading", version: update.version, percent },
          );
        });
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, []);

  return {
    state,
    version,
    check: () => void run(true),
    install,
    dismiss: () => setState({ status: "idle" }),
  };
}
