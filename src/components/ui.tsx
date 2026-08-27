import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { Checkbox, Dialog, Label, Select, Tooltip } from "radix-ui";

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
  /** Fills the width of its container. */
  block?: boolean;
  "aria-label"?: string;
}

export function Button({
  children,
  variant = "default",
  type = "button",
  block = false,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn ${VARIANT_CLASS[variant]}${block ? " is-block" : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** For native inputs, where wrapping in a label is the correct association. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label.Root className="field">
      <span>{label}</span>
      {children}
    </Label.Root>
  );
}

/** Carries its own class so it styles correctly with or without a Field. */
export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" className={`text-input ${className}`.trim()} {...props} />;
}

/** For an address, which is a block of lines rather than one value. */
export function TextArea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`text-input text-area ${className}`.trim()} rows={3} {...props} />;
}

/** A Radix checkbox with its label, used for picking invoice lines. */
export function CheckRow({
  checked,
  onChange,
  disabled = false,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`check-row${disabled ? " is-disabled" : ""}`}>
      <Checkbox.Root
        className="check-box"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      >
        <Checkbox.Indicator className="check-mark">✓</Checkbox.Indicator>
      </Checkbox.Root>
      <span className="check-body">{children}</span>
    </label>
  );
}

export interface DropdownOption {
  /** Radix rejects an empty string, so callers map "none" to null themselves. */
  value: string;
  label: string;
}

/**
 * A Radix Select. `ariaLabel` is required rather than optional: some of these
 * carry no visible label, and an unlabelled listbox is not usable by screen
 * reader.
 *
 * Deliberately not wrapped in a Label — clicking a label bound to a custom
 * trigger toggles it twice. Dropdowns that show a caption use `DropdownField`,
 * which pairs a plain span with the trigger instead.
 */
export function Dropdown({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder,
  mono = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  ariaLabel: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className={`select-trigger${mono ? " num" : ""}`} aria-label={ariaLabel}>
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="select-caret">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={4}>
          <Select.ScrollUpButton className="select-scroll">▴</Select.ScrollUpButton>
          <Select.Viewport className="select-viewport">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                className={`select-item${mono ? " num" : ""}`}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="select-scroll">▾</Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/**
 * A dropdown with a visible caption. `inline` puts the caption beside the
 * control instead of above it, which matters in the popover where vertical
 * space is the scarce dimension.
 */
export function DropdownField({
  label,
  inline = false,
  ...dropdown
}: {
  label: string;
  inline?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className={`field${inline ? " is-inline" : ""}`}>
      <span>{label}</span>
      <Dropdown ariaLabel={label} {...dropdown} />
    </div>
  );
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
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <Dialog.Title className="modal-title">{title}</Dialog.Title>
            {/* Only the body scrolls, so the buttons stay reachable however tall
                the content gets. */}
            <div className="modal-body">{children}</div>
            <div className="form-actions modal-actions">
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

/** A document with ruled lines, for the invoice action. */
export function InvoiceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <path d="M3.4 1.9h6.2l3 3v9.2H3.4z" strokeLinejoin="round" />
        <path d="M9.4 2.1v3h3" strokeLinejoin="round" />
        <path d="M5.7 8.2h4.6M5.7 10.8h3" />
      </g>
    </svg>
  );
}
