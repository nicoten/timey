import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Dialog, Tooltip } from "radix-ui";

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

/**
 * A native select on purpose. It is already accessible and keyboard-driven, it
 * behaves the way the platform does, and it handles the 96-option start-time
 * list better than any custom listbox would.
 */
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
 * A modal form built on Radix Dialog, which supplies the focus trap, Escape and
 * outside-click dismissal, scroll locking, and ARIA wiring.
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
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        {/* No description element, so opt out rather than leave a dangling id. */}
        <Dialog.Content className="modal" aria-describedby={undefined}>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <Dialog.Title className="modal-title">{title}</Dialog.Title>
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Wraps a trigger in a Radix tooltip. The child must be a single element that
 * accepts a ref, which `asChild` forwards to.
 */
export function HoverTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" sideOffset={5}>
          {label}
          <Tooltip.Arrow className="tip-arrow" width={9} height={4} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
