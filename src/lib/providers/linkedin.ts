import "server-only";
import type { ProviderStatus } from "../types";

/**
 * LinkedIn data. Primary: Unipile (a separate LinkedIn account connected in the
 * Unipile dashboard). Fallback: an Apify actor that reads public profiles.
 * CONTRACT: signatures below are fixed; implementations are owned by the linkedin agent.
 */

export interface LinkedInExperience {
  title: string | null;
  company: string | null;
  companyLinkedinUrl: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
}

export interface LinkedInEducation {
  school: string | null;
  degree: string | null;
  field: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface LinkedInProfile {
  url: string;
  publicId: string | null;
  /** Provider-internal id (Unipile provider_id / urn). Needed for posts on Unipile. */
  providerId: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  about: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  currentCompanyLinkedinUrl: string | null;
  currentCompanyDomain: string | null;
  experience: LinkedInExperience[];
  education: LinkedInEducation[];
  skills: string[];
  websites: string[];
  followers: number | null;
  connections: number | null;
  via: "unipile" | "apify";
}

export interface LinkedInPost {
  url: string | null;
  text: string;
  postedAt: string | null;
  reactions: number | null;
  comments: number | null;
  isRepost: boolean;
}

export interface LinkedInCompany {
  name: string | null;
  linkedinUrl: string | null;
  website: string | null;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  employeeRange: string | null;
  headquarters: string | null;
  description: string | null;
  specialties: string[];
  foundedYear: number | null;
  via: "unipile" | "apify";
}

/** Full profile for a linkedin.com/in/... URL. Never throws: errors come back in `error`. */
export async function getLinkedInProfile(profileUrl: string): Promise<{ profile: LinkedInProfile | null; error?: string }> {
  void profileUrl;
  throw new Error("not implemented");
}

/** Recent posts by the person, newest first. Never throws. */
export async function getLinkedInPosts(
  profileUrl: string,
  opts?: { limit?: number; providerId?: string | null },
): Promise<{ posts: LinkedInPost[]; error?: string }> {
  void profileUrl;
  void opts;
  throw new Error("not implemented");
}

/** Company page by linkedin.com/company/... URL or company name. Never throws. */
export async function getLinkedInCompany(companyUrlOrName: string): Promise<{ company: LinkedInCompany | null; error?: string }> {
  void companyUrlOrName;
  throw new Error("not implemented");
}

export function linkedinStatus(): ProviderStatus {
  throw new Error("not implemented");
}
