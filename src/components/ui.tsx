import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

import { errorMessage } from "../lib/api";

type ButtonVariant = "default" | "primary" | "quiet" | "danger" | "step";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "is-primary",
  quiet: "is-quiet",
  danger: "is-danger is-quiet",
  step: "is-step is-quiet",
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
