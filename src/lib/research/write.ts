import "server-only";
import { z } from "zod";
import { ANGLE_LIBRARY } from "../abstract-context";
import { generateObject } from "../claude";
import type { Angle, Approach, Brief, Cited, CompanyPicture, Finding, Settings } from "../types";
import type { Person } from "./context";
import {
  ANGLES_SYSTEM,
  anglesPrompt,
  BOOKING_PLACEHOLDER,
  BOOKING_TOKEN,
  BRIEF_SYSTEM,
  briefPrompt,
  LINKEDIN_CHAR_LIMIT,
} from "./prompts";
import { compact, domainFromUrl, fitToLimit, truncate, uniqueBy } from "./util";

/**
 * Step 5: write the brief, the company picture, the angles with their drafts and
 * the approach. Two Haiku calls (brief + picture, angles + approach) so they can
 * run side by side. The model sees findings as F1, F2, ...; this module maps the
 * labels back to real finding ids and drops any label that does not exist.
 */

// ---------------------------------------------------------------- aliases (pure)

export interface AliasMap {
  aliasOf: Map<string, string>;
  idOf: Map<string, string>;
}

export function aliasFindings(findings: Finding[]): AliasMap {
  const aliasOf = new Map<string, string>();
  const idOf = new Map<string, string>();
  findings.forEach((f, i) => {
    const alias = `F${i + 1}`;
    aliasOf.set(f.id, alias);
    idOf.set(alias, f.id);
  });
  return { aliasOf, idOf };
}

/** "F3", "[f3]", "F3." or a real finding id -> real ids, in order, without duplicates. Unknown labels vanish. */
export function resolveIds(labels: unknown, map: AliasMap): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    // A model sometimes packs several labels into one string: "F1, F2".
    for (const part of raw.split(/[\s,;]+/)) {
      const label = part.replace(/[^A-Za-z0-9-]/g, "");
      if (!label) continue;
      const id = map.idOf.get(label.toUpperCase()) ?? (map.aliasOf.has(label.toLowerCase()) ? label.toLowerCase() : map.aliasOf.has(label) ? label : null);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * Removes finding labels the model left inside prose ("... on the cart (F2).").
 * Labels belong in findingIds only; in text they would mean nothing to the reader.
 */
export function stripAliases(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/\s*[\[(]\s*F\d{1,3}(?:\s*(?:,|and|&)\s*F\d{1,3})*\s*[\])]/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}

function citedList(items: Array<{ text: string; findingIds: string[] }> | undefined, map: AliasMap, max: number): Cited[] {
  return (items ?? [])
    .map((item) => ({ text: stripAliases(item.text), findingIds: resolveIds(item.findingIds, map) }))
    // A claim whose citations all turned out to be invalid is unsupported: leave it out.
    .filter((item) => item.text && item.findingIds.length > 0)
    .slice(0, max);
}

const cleanList = (items: string[] | undefined, max: number) =>
  uniqueBy(compact((items ?? []).map((s) => stripAliases(s))), (s) => s.toLowerCase()).slice(0, max);

// ---------------------------------------------------------------- brief + company picture

const CitedSchema = z.object({ text: z.string(), findingIds: z.array(z.string()) });

export const BriefSchema = z.object({
  brief: z.object({
    summary: z.string(),
    bullets: z.array(CitedSchema),
    pains: z.array(CitedSchema),
    objections: z.array(z.string()),
    questions: z.array(z.string()),
  }),
  companyPicture: z.object({
    name: z.string().nullable(),
    domain: z.string().nullable(),
    oneLiner: z.string().nullable(),
    headcount: z.string().nullable(),
    growth: z.string().nullable(),
    funding: z.string().nullable(),
    team: z.array(CitedSchema),
    hiring: z.array(CitedSchema),
    robotsAndModels: z.array(CitedSchema),
    decisionMakers: z.array(CitedSchema),
  }),
});

const orNull = (value: string | null | undefined): string | null => {
  const v = stripAliases(value);
  return v && !/^(unknown|n\/a|none|null|not (known|available|stated))\.?$/i.test(v) ? v : null;
};

/** Model output -> Brief and CompanyPicture with real finding ids. Pure. */
export function shapeBrief(rawOut: z.infer<typeof BriefSchema>, map: AliasMap, person: Person): { brief: Brief; companyPicture: CompanyPicture } {
  const b = rawOut.brief;
  const c = rawOut.companyPicture;
  return {
    brief: {
      summary: stripAliases(b.summary),
      bullets: citedList(b.bullets, map, 8),
      pains: citedList(b.pains, map, 4),
      objections: cleanList(b.objections, 4),
      questions: cleanList(b.questions, 5),
    },
    companyPicture: {
      // What identify established beats the model's reading of the findings.
      name: person.company ?? orNull(c.name),
      domain: person.domain ?? domainFromUrl(orNull(c.domain)),
      oneLiner: orNull(c.oneLiner),
      headcount: orNull(c.headcount),
      growth: orNull(c.growth),
      funding: orNull(c.funding),
      team: citedList(c.team, map, 6),
      hiring: citedList(c.hiring, map, 6),
      robotsAndModels: citedList(c.robotsAndModels, map, 8),
      decisionMakers: citedList(c.decisionMakers, map, 6),
    },
  };
}

export async function writeBrief(input: {
  leadId?: string | null;
  person: Person;
  findings: Finding[];
  instruction?: string | null;
  timeoutMs?: number;
}): Promise<{ brief: Brief; companyPicture: CompanyPicture }> {
  const map = aliasFindings(input.findings);
  const out = await generateObject({
    leadId: input.leadId,
    label: "Writing the brief",
    system: BRIEF_SYSTEM,
    prompt: briefPrompt({ person: input.person, findings: input.findings, aliasOf: map.aliasOf, instruction: input.instruction }),
    schema: BriefSchema,
    maxTokens: 10_000,
    timeoutMs: input.timeoutMs,
  });
  return shapeBrief(out, map, input.person);
}

// ---------------------------------------------------------------- angles + approach

export const AnglesSchema = z.object({
  angles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      reasoning: z.string(),
      findingIds: z.array(z.string()),
      emailSubject: z.string(),
      emailBody: z.string(),
      linkedinMessage: z.string(),
    }),
  ),
  approach: z.object({
    leadAngleId: z.string().nullable(),
    channel: z.enum(["email", "linkedin", "either"]),
    why: z.string(),
    firstCallQuestions: z.array(z.string()),
    dealBreakers: z.array(z.string()),
  }),
});

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/**
 * Model output -> angles (drafts still carry the booking token and no sign-off;
 * finalizeAngles adds those after verification) and the approach. Pure.
 */
export function shapeAngles(rawOut: z.infer<typeof AnglesSchema>, map: AliasMap): { angles: Angle[]; approach: Approach } {
  const used = new Set<string>();
  const renamed = new Map<string, string>();
  const angles: Angle[] = [];
  for (const a of rawOut.angles ?? []) {
    const body = stripAliases(a.emailBody);
    if (!body) continue;
    const library = ANGLE_LIBRARY.find((l) => l.id === slug(a.id ?? ""));
    let id = library?.id ?? (slug(a.id ?? "") || slug(a.name ?? "") || "angle");
    const wanted = id;
    for (let n = 2; used.has(id); n++) id = `${wanted}-${n}`;
    used.add(id);
    if (!renamed.has(a.id)) renamed.set(a.id, id);
    angles.push({
      id,
      name: a.name?.trim() || library?.name || "Angle",
      reasoning: stripAliases(a.reasoning),
      findingIds: resolveIds(a.findingIds, map),
      email: { subject: truncate(stripAliases(a.emailSubject).replace(/\s+/g, " "), 140), body },
      linkedinMessage: stripAliases(a.linkedinMessage),
    });
    if (angles.length === 4) break;
  }
  const ap = rawOut.approach;
  const lead = ap?.leadAngleId ? (renamed.get(ap.leadAngleId) ?? slug(ap.leadAngleId)) : null;
  return {
    angles,
    approach: {
      leadAngleId: lead && angles.some((a) => a.id === lead) ? lead : (angles[0]?.id ?? null),
      channel: ap?.channel ?? "either",
      why: stripAliases(ap?.why),
      firstCallQuestions: cleanList(ap?.firstCallQuestions, 5),
      dealBreakers: cleanList(ap?.dealBreakers, 4),
    },
  };
}

export async function writeAngles(input: {
  leadId?: string | null;
  person: Person;
  findings: Finding[];
  settings: Settings;
  notes?: string | null;
  instruction?: string | null;
  currentAngles?: Angle[];
  timeoutMs?: number;
}): Promise<{ angles: Angle[]; approach: Approach }> {
  const map = aliasFindings(input.findings);
  const out = await generateObject({
    leadId: input.leadId,
    label: "Writing the outreach drafts",
    system: ANGLES_SYSTEM,
    prompt: anglesPrompt({
      person: input.person,
      findings: input.findings,
      aliasOf: map.aliasOf,
      settings: input.settings,
      notes: input.notes,
      instruction: input.instruction,
      currentAngles: input.currentAngles,
    }),
    schema: AnglesSchema,
    maxTokens: 12_000,
    timeoutMs: input.timeoutMs,
  });
  return shapeAngles(out, map);
}

// ---------------------------------------------------------------- finishing drafts (pure)

const SIGN_OFF = /^(best|best regards|kind regards|regards|thanks|thank you|cheers|sincerely|warmly|talk soon),?$/i;

/** Removes a sign-off the model added despite being told not to, so the app does not sign twice. */
export function stripSignOff(body: string): string {
  const lines = body.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    if (SIGN_OFF.test(lines[i].trim())) {
      // Only cut when what follows the sign-off word is a short name block, not real content.
      const tail = lines.slice(i + 1).join(" ").trim();
      if (tail.length <= 60) return lines.slice(0, i).join("\n").trimEnd();
    }
  }
  return body.trimEnd();
}

export function signOff(settings: Pick<Settings, "senderName" | "signature">): string {
  const name = settings.senderName?.trim();
  const signature = settings.signature?.trim();
  if (signature) {
    // A signature that already carries the name replaces it; otherwise it goes under the name.
    const hasName = name && signature.toLowerCase().includes(name.toLowerCase());
    return `Best,\n${hasName || !name ? signature : `${name}\n${signature}`}`;
  }
  return `Best,\n${name || "[your name]"}`;
}

/**
 * Turns verified drafts into what the teammate sees: the booking link (or a
 * visible placeholder) in place of the token, the sign-off, and a LinkedIn
 * message that fits a connection note.
 */
export function finalizeAngles(angles: Angle[], settings: Pick<Settings, "senderName" | "signature" | "calendlyUrl">): Angle[] {
  const link = settings.calendlyUrl?.trim() || BOOKING_PLACEHOLDER;
  const fill = (text: string) => text.split(BOOKING_TOKEN).join(link).replace(/\{\{\s*BOOKING_LINK\s*\}\}/gi, link);
  return angles.map((a) => {
    const body = `${fill(stripSignOff(a.email.body)).replace(/\n{3,}/g, "\n\n").trim()}\n\n${signOff(settings)}`;
    // A link does not belong in a connection note: drop the token and tidy what is left.
    const linkedin = a.linkedinMessage
      .replace(/\{\{\s*BOOKING_LINK\s*\}\}/gi, "")
      .replace(/\s+([.,!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    return {
      ...a,
      email: { subject: fill(a.email.subject).trim(), body },
      linkedinMessage: fitToLimit(linkedin, LINKEDIN_CHAR_LIMIT - 1),
    };
  });
}
