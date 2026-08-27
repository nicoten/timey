import type { UpdateState } from "../lib/updateState";
import { Button } from "./ui";

interface Props {
  state: UpdateState;
  onInstall: () => void;
  onDismiss: () => void;
}

/** A quiet strip under the top rail. Renders only when there is something to say. */
export function UpdateBanner({ state, onInstall, onDismiss }: Props) {
  if (state.status === "available") {
    return (
      <div className="notice">
        <span>
          Version <span className="num">{state.version}</span> is available.
        </span>
        <span className="notice-actions">
          <Button variant="primary" onClick={onInstall}>
            Update and restart
          </Button>
          <Button variant="quiet" onClick={onDismiss}>
            Later
          </Button>
        </span>
      </div>
    );
  }

  if (state.status === "downloading") {
    return (
      <div className="notice">
        <span>
          Downloading <span className="num">{state.version}</span>
          {state.percent === null ? "…" : ` — ${Math.round(state.percent * 100)}%`}
        </span>
        {state.percent !== null && (
          <span className="progress" aria-hidden="true">
            <span className="progress-fill" style={{ width: `${state.percent * 100}%` }} />
          </span>
        )}
      </div>
    );
  }

  if (state.status === "installing") {
    return (
      <div className="notice">
        <span>Installing — the app will restart on its own.</span>
      </div>
    );
  }

  return null;
}
