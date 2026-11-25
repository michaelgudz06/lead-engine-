/**
 * Scoring and ranking warm paths. Pure and client-safe; points never leave the server (paths carry
 * strength words only).
 *
 * Points per piece of evidence on a link:
 * - worked together: 5 (overlap >= 12 months, ended within 8 years or still going, company known to
 *   have <= 1,000 employees), else 3 (src/lib/paths/overlap.ts decides)
 * - both work there now, start dates unknown: 3
 * - LinkedIn 1st degree: 3
 * - mutual follow on X: 3
 * - same school with overlapping years: 2; with unknown years: 0 (shown)
 * - a one-way follow that counts ("Follows you", "Ada follows them"): 1, or 0 when the connector
 *   has more than 50,000 followers
 * - a one-way follow that does not count ("You follow them", "Follows Ada"): 0, shown only next to
 *   other evidence
 * A link scores the sum, capped at 8: 5+ Strong, 3-4 Medium, 1-2 Weak, 0 drops the path. A path is
 * as strong as its weaker link.
 */

import type { Evidence, FollowDirection, WarmConnector, WarmLink, WarmPath, WarmStrength } from "./types";

/** A piece of evidence with the points it is worth on its link. */
export interface ScoredEvidence {
  evidence: Evidence;
  points: number;
}

export const POINTS = {
  workedTogetherStrong: 5,
  workedTogether: 3,
  worksAt: 3,
  linkedin1st: 3,
  mutualFollow: 3,
  sameSchool: 2,
  oneWayFollow: 1,
} as const;

export const LINK_SCORE_CAP = 8;
/** One-way follows of an account with more followers than this count for nothing. */
export const BIG_ACCOUNT_FOLLOWERS = 50_000;

/** The follow directions that count a little; the other two are shown next to other evidence only. */
export const COUNTING_FOLLOWS: readonly FollowDirection[] = ["connector_follows_you", "lead_follows_connector"];

/** Points for a one-way follow: 1 for one that counts (0 for a connector above 50,000 followers), else 0. */
export function followPoints(who: FollowDirection, connectorFollowers: number | null | undefined): number {
  if (!COUNTING_FOLLOWS.includes(who)) return 0;
  return typeof connectorFollowers === "number" && connectorFollowers > BIG_ACCOUNT_FOLLOWERS ? 0 : POINTS.oneWayFollow;
}

/** Evidence for one X relation on a link, or null when there is none. `a` is you (your link) or the lead (the lead's link). */
export function xEvidence(
  side: "you" | "lead",
  rel: { aFollowsB: boolean; bFollowsA: boolean },
  connectorFollowers: number | null | undefined,
): ScoredEvidence | null {
  // Your link: a = you, b = the connector. The lead's link: a = the lead, b = the connector.
  if (rel.aFollowsB && rel.bFollowsA) return { evidence: { kind: "mutual_follow", network: "x" }, points: POINTS.mutualFollow };
  if (side === "you") {
    if (rel.bFollowsA) return follows("connector_follows_you", connectorFollowers);
    if (rel.aFollowsB) return follows("you_follow_connector", connectorFollowers);
  } else {
    if (rel.aFollowsB) return follows("lead_follows_connector", connectorFollowers);
    if (rel.bFollowsA) return follows("connector_follows_lead", connectorFollowers);
  }
  return null;
}

function follows(who: FollowDirection, connectorFollowers: number | null | undefined): ScoredEvidence {
  return { evidence: { kind: "follows", network: "x", who }, points: followPoints(who, connectorFollowers) };
}

/** A link's score: the sum of its points, capped at 8. */
export function linkScore(items: ReadonlyArray<ScoredEvidence>): number {
  return Math.min(LINK_SCORE_CAP, items.reduce((sum, i) => sum + Math.max(0, i.points), 0));
}

/** 5+ Strong, 3-4 Medium, 1-2 Weak, 0 none. */
export function strengthOf(score: number): WarmStrength | null {
  if (score >= 5) return "strong";
  if (score >= 3) return "medium";
  if (score >= 1) return "weak";
  return null;
}

const STRENGTH_ORDER: Record<WarmStrength, number> = { strong: 0, medium: 1, weak: 2 };

/** The weaker of two strengths. */
export function weaker(a: WarmStrength, b: WarmStrength): WarmStrength {
  return STRENGTH_ORDER[a] >= STRENGTH_ORDER[b] ? a : b;
}

/** Evidence kinds in the order a link lists them when their points tie: confirmed ties first, then overlaps. */
const KIND_ORDER: Record<Evidence["kind"], number> = {
  linkedin_1st: 0,
  mutual_follow: 1,
  worked_together: 2,
  works_at: 3,
  same_school: 4,
  follows: 5,
};

/** Best first: more points, then the kind order, then the more recent years. Removes duplicates (same kind and org or direction). */
export function sortEvidence(items: ReadonlyArray<ScoredEvidence>): ScoredEvidence[] {
  const key = (e: Evidence) =>
    e.kind === "follows" ? `follows:${e.who}` : e.kind === "worked_together" || e.kind === "same_school" || e.kind === "works_at" ? `${e.kind}:${e.org.toLowerCase()}` : e.kind;
  const best = new Map<string, ScoredEvidence>();
  for (const item of items) {
    const k = key(item.evidence);
    const seen = best.get(k);
    if (!seen || item.points > seen.points) best.set(k, item);
  }
  return [...best.values()].sort((a, b) => b.points - a.points || KIND_ORDER[a.evidence.kind] - KIND_ORDER[b.evidence.kind] || recentYear(b.evidence) - recentYear(a.evidence));
}

/** The most recent shared year of a piece of evidence: Infinity while it goes on, -Infinity when it has none. */
export function recentYear(e: Evidence): number {
  if (e.kind === "worked_together") return e.toYear ?? Infinity;
  if (e.kind === "same_school") return e.toYear ?? -Infinity;
  if (e.kind === "works_at") return Infinity;
  return -Infinity;
}

/**
 * One person (or the lead, for a direct path) with everything known about each link, before it is
 * scored. you: your link (the only one on a direct path). lead: the lead's link (empty when direct).
 */
export interface PathCandidate {
  id: string;
  hops: 1 | 2;
  connector: WarmConnector | null;
  you: ScoredEvidence[];
  lead: ScoredEvidence[];
  /** The provider's own order (LinkedIn's ranking of shared connections), lower first. */
  providerOrder?: number | null;
}

/** A scored candidate: the path plus what ranks it. */
export interface RankedPath {
  path: Omit<WarmPath, "rank" | "introDraft" | "askedAt">;
  weakScore: number;
  totalScore: number;
  recent: number;
  providerOrder: number;
  name: string;
}

/**
 * Scores a candidate: each link capped at 8, a strength per link, the path as strong as its weaker
 * link. Null when a link scores 0 (the path is dropped).
 */
export function scoreCandidate(c: PathCandidate): RankedPath | null {
  const links = c.hops === 1 ? [c.you] : [c.you, c.lead];
  const scored: Array<{ score: number; strength: WarmStrength; items: ScoredEvidence[] }> = [];
  for (const items of links) {
    const sorted = sortEvidence(items);
    const score = linkScore(sorted);
    const strength = strengthOf(score);
    if (!strength) return null;
    scored.push({ score, strength, items: sorted });
  }
  const strength = scored.map((l) => l.strength).reduce(weaker);
  const all = scored.flatMap((l) => l.items.map((i) => i.evidence));
  const outLinks: WarmLink[] = scored.map((l) => ({ strength: l.strength, evidence: l.items.map((i) => i.evidence) }));
  return {
    path: { id: c.id, hops: c.hops, strength, connector: c.connector, links: outLinks },
    weakScore: Math.min(...scored.map((l) => l.score)),
    totalScore: scored.reduce((sum, l) => sum + l.score, 0),
    recent: all.reduce((m, e) => Math.max(m, recentYear(e)), -Infinity),
    providerOrder: typeof c.providerOrder === "number" ? c.providerOrder : Infinity,
    name: (c.connector?.name ?? "").toLowerCase(),
  };
}

/**
 * The ranking. Each rule only breaks ties left by the one before:
 * direct before two-hop; Strong, Medium, Weak; the higher score of the weaker link; the higher
 * total; the most recent shared year (still going first); the provider's own order; name A-Z.
 */
export function comparePaths(a: RankedPath, b: RankedPath): number {
  if (a.path.hops !== b.path.hops) return a.path.hops - b.path.hops;
  const sa = STRENGTH_ORDER[a.path.strength ?? "weak"];
  const sb = STRENGTH_ORDER[b.path.strength ?? "weak"];
  if (sa !== sb) return sa - sb;
  if (a.weakScore !== b.weakScore) return b.weakScore - a.weakScore;
  if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
  if (a.recent !== b.recent) return b.recent > a.recent ? 1 : -1;
  if (a.providerOrder !== b.providerOrder) return a.providerOrder < b.providerOrder ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Scores, drops the paths with a zero link, ranks, keeps `max`, and numbers them from 1. */
export function rankPaths(candidates: ReadonlyArray<PathCandidate>, max: number): Array<Omit<WarmPath, "introDraft" | "askedAt">> {
  return candidates
    .map(scoreCandidate)
    .filter((r): r is RankedPath => r !== null)
    .sort(comparePaths)
    .slice(0, max)
    .map((r, i) => ({ ...r.path, rank: i + 1 }));
}

/**
 * What the panel shows before "Show N more": up to 3 paths rated Medium or better; when there is
 * none, only the best Weak one. `more` is the rest, Strong then Medium then Weak, in rank order
 * within each (a weak direct overlap ranks first among the hops, but never above a Medium path).
 */
export function panelPaths<T extends Pick<WarmPath, "strength">>(paths: ReadonlyArray<T>, shown = 3): { shown: T[]; more: T[] } {
  const good = paths.filter((p) => p.strength === "strong" || p.strength === "medium");
  const first = good.length ? good.slice(0, shown) : paths.slice(0, 1);
  const set = new Set(first);
  const order = (p: T) => STRENGTH_ORDER[p.strength ?? "weak"];
  // Array.prototype.sort is stable: rank order holds within a strength.
  return { shown: first, more: paths.filter((p) => !set.has(p)).sort((a, b) => order(a) - order(b)) };
}

/** A confirmed tie: LinkedIn 1st degree or a mutual follow. A one-way follow is Weak evidence, never a tie. */
export const isConfirmedTie = (e: Evidence): boolean => e.kind === "linkedin_1st" || e.kind === "mutual_follow";

/**
 * True for a direct path with a confirmed tie (always Medium or better): the "direct box", the
 * header's "You're connected" and the list's "Connected" chip, which so always agree.
 */
export function isConfirmedDirect(path: Pick<WarmPath, "hops" | "links">): boolean {
  if (path.hops !== 1) return false;
  return (path.links[0]?.evidence ?? []).some(isConfirmedTie);
}

/** Which network a path's evidence comes from. */
export function pathNetwork(path: Pick<WarmPath, "links">): "linkedin" | "x" | "mixed" {
  const kinds = path.links.flatMap((l) => l.evidence.map((e) => e.kind));
  const x = kinds.some((k) => k === "mutual_follow" || k === "follows");
  const li = kinds.some((k) => k !== "mutual_follow" && k !== "follows");
  return x && li ? "mixed" : x ? "x" : "linkedin";
}
