"use client";

import type { Finding, Source } from "@/lib/types";
import { SOURCE_LABELS } from "@/lib/types";
import { hostOf, safeUrl } from "../format";
import { cx } from "../ui";

/** Findings read off the open web (search results, pages the agent read). The rest is provider data. */
const WEB_SOURCES: ReadonlySet<Source> = new Set<Source>(["exa", "agent"]);
/** Sites that are also a source keep the source's name, so one site never shows two ways. */
const SITE_NAMES: Array<[string, string]> = [
  ["linkedin.com", SOURCE_LABELS.linkedin],
  ["x.com", SOURCE_LABELS.x],
  ["twitter.com", SOURCE_LABELS.x],
  ["huggingface.co", SOURCE_LABELS.huggingface],
];

/** "techcrunch.com" for a web finding; the source's name ("LinkedIn", "Apollo", "Your notes") otherwise. */
function sourceLabel(f: Finding, url: string | null): string {
  const host = url && WEB_SOURCES.has(f.source) ? hostOf(url) : "";
  if (!host) return SOURCE_LABELS[f.source] ?? f.source;
  return SITE_NAMES.find(([site]) => host === site || host.endsWith(`.${site}`))?.[1] ?? host;
}

/** A titled card: the building block of the lead page. A className with its own scroll margin replaces the default one. */
export function Panel({ title, aside, children, id, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={cx("card", !className?.includes("scroll-mt-") && "scroll-mt-20", className)} aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-3 sm:px-5">
        <h2 className="font-serif text-[20px] leading-snug">{title}</h2>
        {aside}
      </div>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

export function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="eyebrow mb-2">{children}</h3>;
}

/**
 * Small source links after a claim, labelled by site or provider, with the finding's
 * title as the tooltip. Each cited finding id becomes a link to the finding's own URL,
 * or to its row in the Findings section when it has none.
 * Ids that match no finding are dropped rather than shown as dead links.
 */
export function Sources({ ids, findings }: { ids: string[] | undefined; findings: Map<string, Finding> }) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const seen = new Set<string>();
  const items: Array<{ key: string; href: string; external: boolean; label: string; title: string }> = [];
  for (const id of ids) {
    const f = findings.get(id);
    if (!f) continue;
    const url = safeUrl(f.url);
    const href = url ?? `#finding-${f.id}`;
    if (seen.has(href)) continue;
    seen.add(href);
    items.push({ key: f.id, href, external: Boolean(url), label: sourceLabel(f, url), title: f.title || f.text.slice(0, 140) });
  }
  if (items.length === 0) return null;
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-[1px]">
      {items.map((s) => (
        <a
          key={s.key}
          href={s.href}
          title={s.title}
          {...(s.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="max-w-[200px] truncate rounded border border-hairline px-1.5 text-[11px] leading-[17px] text-quiet transition-colors hover:border-link hover:text-link"
        >
          {s.label}
        </a>
      ))}
    </span>
  );
}

/** A bulleted list of cited claims. Renders nothing when the list is empty. */
export function CitedList({ items, findings }: { items: Array<{ text: string; findingIds: string[] }> | undefined | null; findings: Map<string, Finding> }) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && typeof i.text === "string" && i.text.trim());
  if (list.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {list.map((item, i) => (
        <li key={i} className="relative pl-4 wrap-anywhere before:absolute before:left-0 before:top-[0.68em] before:h-1 before:w-1 before:rounded-full before:bg-quiet">
          {item.text}
          <Sources ids={item.findingIds} findings={findings} />
        </li>
      ))}
    </ul>
  );
}

export function PlainList({ items }: { items: string[] | undefined | null }) {
  const list = (Array.isArray(items) ? items : []).filter((i) => typeof i === "string" && i.trim());
  if (list.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {list.map((item, i) => (
        <li key={i} className="relative pl-4 wrap-anywhere before:absolute before:left-0 before:top-[0.68em] before:h-1 before:w-1 before:rounded-full before:bg-quiet">
          {item}
        </li>
      ))}
    </ul>
  );
}
