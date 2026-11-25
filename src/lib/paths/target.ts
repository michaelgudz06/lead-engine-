/**
 * The lead's side of a warm path (le_warm_paths.target), captured from a LinkedIn profile read:
 * the member id, roles, schools, the company's size and an Instagram handle from the profile's
 * links. Pure; the profile type is only a type import, so nothing server-only is pulled in.
 */

import type { LinkedInCompany, LinkedInProfile } from "../providers/linkedin";
import { linkedinSlug } from "../linkedin-url";
import { cleanXHandle, normaliseName } from "../research/util";
import { instagramHandleFromUrls } from "./links";
import type { TargetRole, TargetSchool, WarmPathTarget } from "./types";

const MAX_ROLES = 12;
const MAX_SCHOOLS = 5;
const MEMBER_ID = /^A[CD]o[A-Za-z0-9_-]{8,}$/;

/** "YYYY-MM" or "YYYY" as stored, else null (free text from a provider is dropped). */
function cleanMonth(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(v);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

export function rolesFromProfile(profile: Pick<LinkedInProfile, "experience">): TargetRole[] {
  const out: TargetRole[] = [];
  for (const e of profile.experience ?? []) {
    const company = e.company?.trim();
    if (!company) continue;
    const to = cleanMonth(e.endDate);
    out.push({
      company: company.slice(0, 200),
      companyKey: normaliseName(company),
      companyLinkedinUrl: e.companyLinkedinUrl ?? null,
      from: cleanMonth(e.startDate),
      to,
      current: e.endDate == null,
    });
    if (out.length >= MAX_ROLES) break;
  }
  return out;
}

export function schoolsFromProfile(profile: Pick<LinkedInProfile, "education">): TargetSchool[] {
  const out: TargetSchool[] = [];
  for (const e of profile.education ?? []) {
    const school = e.school?.trim();
    if (!school) continue;
    out.push({ school: school.slice(0, 200), schoolId: e.schoolId ?? null, from: cleanMonth(e.startDate), to: cleanMonth(e.endDate) });
    if (out.length >= MAX_SCHOOLS) break;
  }
  return out;
}

/**
 * A target from a profile read during research (or by the Unipile-only read), merged over what
 * was stored: a manual Instagram handle is kept, the X handle comes from the lead row (the verified
 * one), and the X user id is kept only while the handle is the same.
 */
export function captureTarget(input: {
  profile: LinkedInProfile | null;
  company?: Pick<LinkedInCompany, "employeeCount" | "linkedinUrl" | "name"> | null;
  lead: { linkedinUrl: string | null; linkedinSlug: string | null; xHandle: string | null };
  previous?: WarmPathTarget | null;
  now?: Date;
}): WarmPathTarget {
  const { profile, previous, lead } = input;
  const xHandle = cleanXHandle(lead.xHandle);
  const sameX = Boolean(previous?.xHandle && xHandle && previous.xHandle.toLowerCase() === xHandle.toLowerCase());
  const fromLinks = profile ? instagramHandleFromUrls(profile.websites ?? []) : null;
  const manual = previous?.instagramSource === "manual" ? previous.instagramHandle : null;
  const instagramHandle = manual ?? fromLinks ?? (previous?.instagramSource === "profile" ? previous.instagramHandle : null);
  const roles = profile ? rolesFromProfile(profile) : (previous?.roles ?? []);
  const schools = profile ? schoolsFromProfile(profile) : (previous?.schools ?? []);
  const memberId = profile?.providerId && MEMBER_ID.test(profile.providerId) ? profile.providerId : (previous?.linkedinMemberId ?? null);
  const current = roles.find((r) => r.current);
  const sizeFits = Boolean(input.company && current && (sameCompanyPage(input.company.linkedinUrl, current.companyLinkedinUrl) || normaliseName(input.company.name) === current.companyKey));
  const sized = sizeFits && typeof input.company?.employeeCount === "number";
  const companySize = sized ? (input.company?.employeeCount ?? null) : profile ? null : (previous?.companySize ?? null);
  const companySizeKey = sized && current ? normaliseName(current.company) : profile ? null : (previous?.companySizeKey ?? null);
  return {
    linkedinSlug: lead.linkedinSlug ?? (lead.linkedinUrl ? linkedinSlug(lead.linkedinUrl) : null),
    linkedinPublicId: profile?.publicId ?? previous?.linkedinPublicId ?? null,
    linkedinMemberId: memberId,
    roles,
    schools,
    companySize,
    companySizeKey,
    xHandle,
    xUserId: sameX ? (previous?.xUserId ?? null) : null,
    instagramHandle,
    instagramSource: instagramHandle ? (manual ? "manual" : "profile") : null,
    capturedAt: (input.now ?? new Date()).toISOString(),
  };
}

function sameCompanyPage(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (u: string | null | undefined) => /linkedin\.com\/company\/([^/?#\s]+)/i.exec(u ?? "")?.[1]?.toLowerCase() ?? null;
  const ka = key(a);
  return ka !== null && ka === key(b);
}

/** True when a target has what the free matching needs beyond the slug: the member id or any role or school. */
export function targetIsCaptured(t: WarmPathTarget | null | undefined): boolean {
  return Boolean(t && (t.linkedinMemberId || t.roles.length || t.schools.length));
}
