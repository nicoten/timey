import { useEffect, useRef } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

import { errorMessage } from "../lib/api";

type ButtonVariant = "default" | "primary" | "quiet" | "danger" | "step" | "add";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "is-primary",
  quiet: "is-quiet",
  danger: "is-danger is-quiet",
  step: "is-step is-quiet",
  add: "is-add",
};

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: ButtonVariant;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
}

export function Button({ children, variant = "default", type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn ${VARIANT_CLASS[variant]}`} {...rest}>
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />;
}

/** Renders nothing when there is no error, so callers need no conditional. */
export function ErrorNote({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p className="error" role="alert">
      {errorMessage(error)}
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/**
 * A modal form. Escape and the backdrop both close it, and the first field takes
 * focus on open so the keyboard works without reaching for the mouse.
 *
 * `onSubmit` is wired here rather than by each caller so every dialog commits on
 * Enter.
 */
export function Modal({
  title,
  submitLabel,
  onSubmit,
  onClose,
  canSubmit = true,
  busy = false,
  children,
}: {
  title: string;
  submitLabel: string;
  onSubmit: () => void;
  onClose: () => void;
  canSubmit?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    // Capture, so this closes the dialog before any other Escape handler runs.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    card.current?.querySelector<HTMLElement>("input, select")?.focus();
  }, []);

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(event) => {
        // Only a click on the backdrop itself, not a drag ending there.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={card}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <h3 className="modal-title">{title}</h3>
          {children}
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={!canSubmit || busy}>
              {submitLabel}
            </Button>
            <Button variant="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
