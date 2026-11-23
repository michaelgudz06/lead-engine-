"use client";

import { cx } from "@/components/ui";

/** Marks a cost that is partly or wholly estimated from usage and the price table. */
export function Est({ className }: { className?: string }) {
  return (
    <abbr
      title="Estimated: worked out from usage and the price table, not reported by the provider"
      className={cx("cursor-help rounded border border-hairline px-1 py-px text-[10.5px] font-medium leading-none text-quiet no-underline", className)}
    >
      est.
    </abbr>
  );
}

/** A titled card section, the same frame the Settings page uses. */
export function Section({
  title,
  description,
  actions,
  children,
  flush,
  id,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** No inner padding (tables run edge to edge). */
  flush?: boolean;
  id?: string;
}) {
  return (
    <section className="card" aria-labelledby={id}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 id={id} className="font-serif text-[20px] leading-snug">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[13px] text-quiet">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={flush ? "" : "p-4 sm:p-5"}>{children}</div>
    </section>
  );
}
