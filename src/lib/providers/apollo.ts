import "server-only";
import type { ProviderStatus } from "../types";

/**
 * Apollo. Organization enrich and job postings work on the free plan.
 * people/match returns 403 on the free plan: report that as planBlocked, never as an error.
 * CONTRACT: signatures fixed; owned by the apollo-hunter agent.
 */

export interface ApolloOrg {
  id: string | null;
  name: string | null;
  domain: string | null;
  website: string | null;
  linkedinUrl: string | null;
  industry: string | null;
  employees: number | null;
  foundedYear: number | null;
  description: string | null;
  city: string | null;
  country: string | null;
  totalFunding: number | null;
  latestFundingStage: string | null;
  latestFundingDate: string | null;
  headcountGrowth6m: number | null;
  headcountGrowth12m: number | null;
  departmentHeadcount: Record<string, number>;
  technologies: string[];
  keywords: string[];
}

export interface ApolloJob {
  title: string;
  url: string | null;
  location: string | null;
  postedAt: string | null;
}

export interface ApolloPerson {
  name: string | null;
  title: string | null;
  headline: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  githubUrl: string | null;
  city: string | null;
  country: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  employmentHistory: Array<{
    title: string | null;
    organization: string | null;
    startDate: string | null;
    endDate: string | null;
    current: boolean;
  }>;
}

export async function enrichOrganization(domain: string): Promise<{ org: ApolloOrg | null; error?: string }> {
  void domain;
  throw new Error("not implemented");
}

export async function getJobPostings(orgId: string, limit?: number): Promise<{ jobs: ApolloJob[]; error?: string }> {
  void orgId;
  void limit;
  throw new Error("not implemented");
}

export async function matchPerson(input: {
  linkedinUrl?: string | null;
  name?: string | null;
  domain?: string | null;
  organizationName?: string | null;
}): Promise<{ person: ApolloPerson | null; planBlocked: boolean; error?: string }> {
  void input;
  throw new Error("not implemented");
}

export function apolloStatus(): ProviderStatus {
  throw new Error("not implemented");
}
