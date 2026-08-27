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

/**
 * A cog. Eight teeth with the centre punched out via `fill-rule: evenodd`,
 * which stays crisp at this size where a stroked ring would blur.
 */
export function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6.60,0.94 L9.40,0.94 L9.34,3.08 L10.54,3.57 L12.00,2.01 L13.99,4.00 L12.43,5.46 L12.92,6.66 L15.06,6.60 L15.06,9.40 L12.92,9.34 L12.43,10.54 L13.99,12.00 L12.00,13.99 L10.54,12.43 L9.34,12.92 L9.40,15.06 L6.60,15.06 L6.66,12.92 L5.46,12.43 L4.00,13.99 L2.01,12.00 L3.57,10.54 L3.08,9.34 L0.94,9.40 L0.94,6.60 L3.08,6.66 L3.57,5.46 L2.01,4.00 L4.00,2.01 L5.46,3.57 L6.66,3.08 Z M10.85,8.00 A2.85,2.85 0 1 0 5.15,8.00 A2.85,2.85 0 1 0 10.85,8.00 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
