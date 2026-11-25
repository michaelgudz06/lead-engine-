import type { Lead } from "@/lib/types";
import { Chip } from "../ui";

/**
 * The list chip for a lead you can reach: "Connected" for a direct tie, "Warm path" for a Strong
 * or Medium path through someone (the server only sends those). The tooltip says which
 * ("Medium path via Priya Shah", "LinkedIn 1st degree"); screen readers get it as text.
 */
export function WarmPathChip({ lead, className }: { lead: Pick<Lead, "warmPath">; className?: string }) {
  const warm = lead.warmPath;
  if (!warm) return null;
  return (
    <Chip className={className} title={warm.label || undefined}>
      {warm.connected ? "Connected" : "Warm path"}
      {warm.label && <span className="sr-only">: {warm.label}</span>}
    </Chip>
  );
}
