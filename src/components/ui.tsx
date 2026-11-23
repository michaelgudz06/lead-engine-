"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { STAGES, STAGE_LABELS, type Stage } from "@/lib/types";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  /** Shows a spinner and blocks clicks while an action is in flight. */
  busy?: boolean;
  /** When set, the button is disabled and this reason shows as a tooltip. */
  disabledReason?: string | null;
  /** Anchor the tooltip to the right edge (for buttons near the screen edge). */
  tipEnd?: boolean;
}

export function Button({ variant = "secondary", size = "md", busy, disabledReason, tipEnd, className, children, disabled, type, ...rest }: ButtonProps) {
  const button = (
    <button
      type={type ?? "button"}
      className={cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)}
      disabled={disabled || busy || Boolean(disabledReason)}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className="spinner" aria-hidden style={variant === "primary" || variant === "danger-solid" ? { borderColor: "rgb(255 255 255 / 0.35)", borderTopColor: "#fff" } : undefined} />}
      {children}
    </button>
  );
  if (!disabledReason) return button;
  return (
    <span className={cx("tip", tipEnd && "tip-end")} data-tip={disabledReason} tabIndex={0} aria-label={disabledReason}>
      {button}
    </span>
  );
}

/** A link that looks like a button. External links open in a new tab. */
export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  external,
  className,
  children,
  ...rest
}: { href: string; variant?: Variant; size?: "md" | "sm"; external?: boolean; className?: string; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const cls = cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className);
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx("text-link underline-offset-2 hover:underline", className)}>
      {children}
    </a>
  );
}

export function Chip({ children, tone, className, title }: { children: React.ReactNode; tone?: "default" | "quiet" | "urgent" | "success" | "solid"; className?: string; title?: string }) {
  const toneClass =
    tone === "urgent" ? "border-[#ecc8c4] text-danger" : tone === "success" ? "border-[#c5e0cf] text-success" : tone === "quiet" ? "text-quiet" : tone === "solid" ? "border-ink bg-ink text-white" : "";
  return (
    <span className={cx("chip", toneClass, className)} title={title}>
      {children}
    </span>
  );
}

export function StageChip({ stage }: { stage: Stage }) {
  const tone = stage === "replied" || stage === "call_booked" ? "success" : stage === "lost" || stage === "nurture" || stage === "new" ? "quiet" : "default";
  return <Chip tone={tone}>{STAGE_LABELS[stage] ?? stage}</Chip>;
}

export function StageSelect({ value, onChange, disabled, small, id }: { value: Stage; onChange: (stage: Stage) => void; disabled?: boolean; small?: boolean; id?: string }) {
  return (
    <select id={id} aria-label="Stage" className={cx("field", small && "field-sm", "w-auto")} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Stage)}>
      {STAGES.map((s) => (
        <option key={s} value={s}>
          {STAGE_LABELS[s]}
        </option>
      ))}
    </select>
  );
}

export function Card({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("card", className)} {...rest}>
      {children}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cx("skeleton", className)} style={style} aria-hidden />;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-serif text-[30px] leading-tight tracking-[-0.01em]">{title}</h1>
        {subtitle && <p className="mt-1 text-quiet">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Label({ htmlFor, children, hint }: { htmlFor?: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px] font-medium">
      <span>{children}</span>
      {hint && <span className="font-normal text-quiet">{hint}</span>}
    </label>
  );
}

/** Inline message. `error` is announced to screen readers straight away. */
export function Notice({ tone = "error", children, action }: { tone?: "error" | "info" | "success"; children: React.ReactNode; action?: React.ReactNode }) {
  const color = tone === "error" ? "border-[#ecc8c4] bg-[#fdf6f5] text-danger" : tone === "success" ? "border-[#c5e0cf] bg-[#f4faf6] text-success" : "border-hairline bg-wash text-ink";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3.5 py-2.5 text-[13.5px]", color)}>
      <div className="min-w-0">{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <h2 className="font-serif text-[22px] leading-snug">{title}</h2>
      {children && <p className="mt-2 max-w-md text-quiet">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "This did not load", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center" role="alert">
      <h2 className="font-serif text-[22px] leading-snug">{title}</h2>
      <p className="mt-2 max-w-md text-quiet">{message}</p>
      {onRetry && (
        <div className="mt-5">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

/** Native <dialog>: focus trapping, Escape to close and the backdrop come for free. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current && !busy) onCancel();
      }}
    >
      <div className="p-5">
        <h2 className="font-serif text-[21px] leading-snug">{title}</h2>
        <div className="mt-2 text-quiet">{children}</div>
        {error && (
          <div className="mt-3">
            <Notice>{error}</Notice>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger-solid" onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
