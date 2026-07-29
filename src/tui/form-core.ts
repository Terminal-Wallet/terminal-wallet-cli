/**
 * Pure, renderer-agnostic form framework — generalizes the tx-builder's
 * field→display→validate→summarize pattern (src/ui/tx-builder-core.ts) to
 * arbitrary single-card utility forms (Add Token, Contacts, Signer import, …).
 *
 * No blessed/SDK imports: a shell (src/ui-blessed/form-card.ts) renders a
 * FormSpec and drives the input-provider; this module owns the field semantics
 * so they stay unit-testable. tx-builder-core stays a separate specialization
 * (its tests are frozen); validation rules here are mirrored, not shared, to
 * avoid disturbing it — converging them later is a follow-up.
 */

export type FormFieldType =
  | "select"
  | "text"
  | "password"
  | "address"
  | "amount"
  | "toggle";

export type FormValue = string | boolean | undefined;
export type FormValues = Record<string, FormValue>;

export interface FormFieldSpec {
  key: string; // stable id, used in the values map
  label: string;
  type: FormFieldType;
  required?: boolean;
  hint?: string; // dimmed format hint (passed to the input editor)
  placeholder?: string; // shown when unset (e.g. "‹select token›")
  /** select only — for display label lookup without awaiting options(). */
  staticOptions?: { label: string; value: string }[];
  /** select only — dynamic choices for the editor (falls back to staticOptions). */
  options?: () => Promise<{ label: string; value: string; hint?: string }[]>;
  addressKind?: "0x" | "0zk"; // address only — drives validation + hint
  secret?: boolean; // never echo the value in display/summary (keys, mnemonics)
  /** Per-field validation; return an error message or undefined when valid. */
  validate?: (value: FormValue, all: FormValues) => string | undefined;
}

export interface FormSpec {
  title: string;
  fields: FormFieldSpec[];
  submitLabel?: string; // default "Save"
  /** Optional live one-liner; falls back to a default summary. */
  summarize?: (values: FormValues) => string;
  /** Cross-field validation; return a form-level error or undefined. */
  validate?: (values: FormValues) => string | undefined;
  submit: (
    values: FormValues,
  ) => Promise<{ ok: boolean; error?: string; message?: string }>;
}

const MASK = "••••••";

const isBlank = (v: FormValue): boolean =>
  v === undefined || v === "" || (typeof v === "string" && v.trim() === "");

/** Display text for one field's current value (placeholder when unset). */
export const formFieldDisplay = (
  field: FormFieldSpec,
  values: FormValues,
): string => {
  const v = values[field.key];
  if (field.type === "toggle") return v ? "On" : "Off";
  if (isBlank(v)) return field.placeholder ?? "—";
  if (field.secret) return MASK;
  if (field.type === "select" && field.staticOptions) {
    return field.staticOptions.find((o) => o.value === v)?.label ?? String(v);
  }
  return String(v);
};

/**
 * Address validation lives in `flows/` — it is the guard between a typo and an
 * irreversible send, which every host needs and no renderer owns. Re-exported
 * here so the form fields and the tx-builder recipient picker are unchanged.
 */
import { addressKindError } from "../flows/address";

export { addressKindError };

/** Mirror of tx-builder-core's amount rule (positive, finite number). */
const isValidAmount = (raw: string): boolean => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
};

const builtInFieldError = (
  field: FormFieldSpec,
  raw: string,
): string | undefined => {
  if (field.type === "address") {
    // The same check the recipient picker uses. This used to be a second copy of
    // the rule, inline and already drifting — so a field could accept an
    // address the picker would refuse.
    const err = addressKindError(field.addressKind === "0zk" ? "0zk" : "0x", raw);
    if (err) return err;
  }
  if (field.type === "amount" && !isValidAmount(raw)) return "Enter a positive amount.";
  return undefined;
};

export interface FormValidation {
  ok: boolean;
  errors: Record<string, string>; // keyed by field.key; "__form" for cross-field
}

/** Validate required + per-field + built-in (address/amount) + cross-field rules. */
export const validateForm = (
  spec: FormSpec,
  values: FormValues,
): FormValidation => {
  const errors: Record<string, string> = {};
  for (const field of spec.fields) {
    const v = values[field.key];
    if (isBlank(v) && field.type !== "toggle") {
      if (field.required) errors[field.key] = `${field.label} is required.`;
      continue; // don't shape-check an empty optional field
    }
    const raw = typeof v === "string" ? v.trim() : "";
    const built = raw ? builtInFieldError(field, raw) : undefined;
    if (built) {
      errors[field.key] = built;
      continue;
    }
    const custom = field.validate?.(v, values);
    if (custom) errors[field.key] = custom;
  }
  const formErr = spec.validate?.(values);
  if (formErr) errors.__form = formErr;
  return { ok: Object.keys(errors).length === 0, errors };
};

/** One-line summary (custom or default: "label: value" for set, non-secret fields). */
export const summarizeForm = (spec: FormSpec, values: FormValues): string => {
  if (spec.summarize) return spec.summarize(values);
  const parts = spec.fields
    .filter((f) => !f.secret && (f.type === "toggle" || !isBlank(values[f.key])))
    .map((f) => `${f.label} ${formFieldDisplay(f, values)}`);
  return parts.join(" · ") || "—";
};
