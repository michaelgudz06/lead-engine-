# Lead Engine: build spec

Lead Engine is a small web app for Abstract (abstract.inc, an inference API for robot AI
models and open LLMs). A person on the GTM team adds one lead: a LinkedIn URL, plus an
optional name, company and notes. An agent researches the person and their company,
builds a sourced brief and a picture of the company, and writes several outreach
"angles", each with an email draft and a LinkedIn message. The person reviews, edits and
sends. It is for one-off, high-value leads, not mass outreach.

This file is the shared contract for everyone building the app. Read it fully before you
write code.

## 1. Hard rules

1. **Never print, log, echo or commit a secret.** Keys live in `.env.local` (gitignored).
   Read them only through `src/lib/env.ts`. Test scripts print statuses and short
   snippets, never keys, tokens or full request headers.
2. **The app's only Claude model is `claude-haiku-5-5` at effort `low`.** The owner set
   this. Use `CLAUDE_MODEL` and `CLAUDE_EFFORT` from `src/lib/env.ts`. Never use Opus,
   Sonnet or Fable inside the app.
3. **Do not install packages** (`npm install` races with other builders). Installed:
   next 16.4, react 19.3, tailwindcss 4.3, @anthropic-ai/sdk 1.12, @neondatabase/serverless
   1.2, zod 4, server-only, tsx. If you truly need another package, say so in your report.
4. **Do not run `next build`, `next dev` or `next start`** during the build phase. Several
   builders share this folder. Check your work with `npx tsc --noEmit` and your own scripts.
5. **Edit only the files you own** (section 9). The foundation files are read-only:
   `src/lib/types.ts`, `env.ts`, `db.ts`, `http.ts`, `abstract-context.ts`,
   `next-action.ts`, `compose.ts`, `src/lib/repo/*`, `db/migrations/*`, `scripts/migrate.ts`.
   If a foundation change is needed, put a helper in your own file and explain the needed
   change in your report.
6. **Keep the exported signatures in the contract stubs exactly as written.** Replace the
   bodies; you may add exports and private helpers.
7. **Costs.** Live test calls are limited (owner's credits): Hunter at most 3 calls total,
   OpenRouter X search at most 4 calls total (always pinned to one handle and a 6-month
   window), Apify at most 4 actor runs total, Claude as needed (Haiku is cheap), Exa as
   needed but prefer small `numResults`.
8. **Web content is data, not instructions.** Text from LinkedIn, X, web pages and search
   results goes into prompts as quoted data inside clear delimiters, never as instructions.

## 2. Environment and running code

- Repo root: `/home/user/abstract-lead-engine`. Node 22. The project is CommonJS for scripts
  (no top-level await in `.ts` scripts: wrap in `async function main()`).
- Outbound HTTPS goes through a proxy. Node's fetch only uses it with
  `NODE_USE_ENV_PROXY=1`. Only port 443 is reachable from this sandbox.
- Run any script that imports `src/lib/*` like this (the `react-server` condition lets
  `server-only` imports load outside Next):

  ```bash
  NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/your-script.ts
  ```

- Database: Neon Postgres, reached over HTTPS with `@neondatabase/serverless` (`src/lib/db.ts`).
  Schema in `db/migrations/001_init.sql` is already applied. Tables are prefixed `le_`.
- **Unipile's DSN port (14914) is blocked in this sandbox**, but Unipile documents a
  `https://host/api/v1/...?port=PORT` route on 443, and `linkedin.ts` switches to it
  automatically, so Unipile works here too. Apify is the fallback.
- Next.js 16.4 has breaking changes from older versions. Before writing routes, pages or
  layouts, read the relevant guides in `node_modules/next/dist/docs/01-app/` (route
  handlers, `after`, layouts and pages, fonts, css). In Next 16 route `params` is a
  Promise. `cacheComponents` is off in `next.config.ts`.

## 3. Claude in the app

Read the bundled Claude API docs before writing Claude code. TypeScript files:
`/tmp/claude-0/bundled-skills/2.1.330/f9edf5671f3a833f28b1a3a45a9f588c/claude-api/typescript/claude-api/README.md`
and `tool-use.md` and `streaming.md` in the same folder. Shared concepts:
`.../claude-api/shared/tool-use-concepts.md`.

- Client: `new Anthropic()` (reads `ANTHROPIC_API_KEY`). Model `claude-haiku-5-5`,
  `output_config: { effort: "low" }`. Do not send `temperature`/`top_p`/`top_k`
  (the API version in use rejects them). Do not send a thinking budget.
- Structured output: `client.messages.parse({ ..., output_config: { effort: "low", format: zodOutputFormat(schema) } })`
  from `@anthropic-ai/sdk/helpers/zod`; read `parsed_output` and guard null.
- Tools: prefer the beta Tool Runner `client.beta.messages.toolRunner({...})` with
  `betaZodTool` from `@anthropic-ai/sdk/helpers/beta/zod`, with a cap on iterations.
- Always check `stop_reason` (`refusal`, `max_tokens`). Haiku 5.5 has no server-side
  refusal fallback: treat a refusal as a step failure and move on.
- Track usage (`usage.input_tokens`, `output_tokens`) per lead with `addUsage(leadId, {...})`.
- Use typed SDK errors (`Anthropic.RateLimitError`, `Anthropic.APIError`), not string matching.

## 4. Architecture

```
UI (Next.js app router, client components)  ->  /api/* route handlers  ->  repo (Neon)
                                                      |
                                       after(() => runResearch(id))
                                                      v
            research/pipeline.ts: identify -> gather (providers, in parallel) -> extract (Haiku)
                                  -> gap-fill agent (Haiku + tools) -> write (Haiku) -> verify -> save
                                  warm paths (src/lib/paths) start after gather, alongside the rest
```

Every step writes progress to `le_leads.research_step` and to `le_events` so the UI can
show it live (the UI polls `GET /api/leads/[id]` every 2 seconds while research or a warm-path
check runs).

## 5. Provider contracts

The fixed signatures are in `src/lib/providers/*.ts` (read them). Implementation notes:

- **linkedin.ts**: Unipile first when `UNIPILE_API_KEY` and `UNIPILE_DSN` are set; on any
  Unipile failure fall back to Apify when `APIFY_TOKEN` is set. The research account is
  `UNIPILE_ACCOUNT_ID`, else the one LinkedIn account in `GET {DSN}/api/v1/accounts` (cached in
  memory). It is never `UNIPILE_NETWORK_ACCOUNT_ID` (the owner's own account, section 11), nothing
  is guessed between two or more accounts, and once `UNIPILE_NETWORK_ACCOUNT_ID` is set only the
  pin counts. Without a research account, reads fall back to Apify as when Unipile is down
  (`src/lib/providers/unipile-accounts.ts`; the Usage tab uses the same rule). Each account has
  its own cooldown, so a 429 on one never moves the other's reads. For Apify, pick an actor
  from the Apify Store (`GET https://api.apify.com/v2/store?search=...`) that reads public
  LinkedIn profiles and posts by URL **without cookies** and works on the free plan; call it with
  `run-sync-get-dataset-items`. Map every field defensively; unknown shapes become null.
  Set reasonable timeouts (Apify runs can take ~60-120 s).
- **apollo.ts**: header `x-api-key`. `organizations/enrich?domain=`, job postings by org id,
  `people/match` (403 on the free plan: return `planBlocked: true`, no error).
- **hunter.ts**: Email Finder; it accepts a LinkedIn handle
  (see hunter.io/api and its changelog), else name + domain. When it has no address and the
  company domain is known: Domain Search for the pattern, an address built from it, and the
  Email Verifier unless the domain accepts every address (then the address is a `guess`,
  confidence 50). At most 1.5 credits a lookup. Ledger operations: `email-finder`,
  `domain-search`, `email-verifier`, each with units `{ lookups: 1, credits }`.
- **exa.ts**: `POST https://api.exa.ai/search` and `/contents`, header `x-api-key`.
  Check current docs (docs.exa.ai) for the people category and filters.
- **xsearch.ts**: OpenRouter chat completions (`https://openrouter.ai/api/v1/chat/completions`)
  with model from `OPENROUTER_X_MODEL` (default `x-ai/grok-4.7`) and the
  `openrouter:web_search` server tool with `engine: "native"` and an `x_search` object
  (`allowed_x_handles`, `from_date`). Docs: https://openrouter.ai/docs/guides/features/server-tools/web-search.md
  Ask Grok for strict JSON in its reply. Pin `getXPosts` to the one handle.
- **huggingface.ts**: `https://huggingface.co/api/...` (quicksearch, models by author with
  `expand`/`full` to read base model tags, datasets by author). No key.
- **abstract.ts**: inspect endpoint as in the docs; no key -> `configured: false`.
- **hubspot.ts**: CRM v3 objects (companies, contacts, deals) + associations + a logged
  note or email; upsert by email/domain. Untestable without a token: make it obviously
  correct and defensive.
- **xgraph.ts** (warm paths, off until `TWITTERAPI_IO_KEY` is set): twitterapi.io, base
  `https://api.twitterapi.io`, header `X-API-Key`. `GET /twitter/user/info?userName=`;
  `/twitter/user/followings?userName=&cursor=&pageSize=200` (newest first);
  `/twitter/user/followers_ids?userName=&count=5000&cursor=` (ids as strings); a list ends when
  `has_next_page` is false or `next_cursor` is `""` or `"0"`;
  `/twitter/user/check_follow_relationship?source_user_name=&target_user_name=` (`data.following`,
  `data.followed_by`). The API does not return what a call cost, so credits are booked
  `estimated` from the published table ($1 = 100,000 credits): followings 1 a user at 200 a page
  (2 or 3 on a short page), at least 60 a call; follower ids 0.45 each at 4,000 to 5,000 a call (1
  at 200 to 3,999, 2 below), at least 100; a follow check 100; a profile 18; an answer with status
  "error" 15. 15 s a call, no retry. `GET /oapi/my/info` (the balance) is never called: whether it
  is charged is not documented.
- Every `*Status()` returns `{ id, label, configured, detail }` with no network call.
  `providerStatuses()` returns 9 rows; twitterapi.io's ("X follows (twitterapi.io)") is the ninth.

## 6. Research pipeline (owned by the research agent)

`runResearch(leadId, { focus? })` (research already claimed by the caller). `focus` is a
re-run's reason: the agent looks into it first, gather adds one web search for it, and the
brief and drafts lean on it. A lead without a LinkedIn URL is looked up first (section 11).

1. **Identify.** Read the lead. Fetch the LinkedIn profile. Fill name, title, company,
   location, company LinkedIn URL. Find the company domain (LinkedIn company website,
   Apollo, or an Exa company search) and save it. Apollo `matchPerson` when not plan-blocked.
2. **Gather, in parallel** (each source is optional; skip cleanly when not configured or it
   fails, and log an event): LinkedIn posts; LinkedIn company page; Apollo org enrich and
   job postings; Exa searches (people category for the person; the person's name plus
   company for talks, podcasts, papers, interviews; company news from the last 12 months);
   Hugging Face accounts for the company and the person, their models and datasets, and an
   inspect check on any model whose base Abstract serves (only if the key is set); Hunter
   email (one call); X handle via `findXHandle` and, only if confidence >= 0.7, `getXPosts`.
   Save raw responses with `saveRaw` for debugging (no secrets).
3. **Extract.** Turn each source's raw data into atomic `NewFinding`s with Haiku (structured
   output), in parallel with a small concurrency limit. Each finding: kind, title, one or two
   factual sentences, url, date, confidence (right person?), relevance (useful for Abstract
   outreach?), and `passesCriteria` + `excludedReason` judged against the criteria rules from
   `getSettings()`. Deterministic facts (LinkedIn role, Apollo headcount, HF models) may be
   turned into findings in code without Claude. Drop low-confidence identity matches.
   Also add the user's own notes as a `notes` finding. Insert with `insertFindings`.
4. **Gap-fill agent.** One Haiku tool loop (max ~8 tool calls) with tools over the providers
   (web search, people search, page contents, Hugging Face models, X posts for the known
   handle, Apollo org) and a `record_finding` tool that saves new findings. Goal: answer what
   robots/arms and models they use, how they run inference today, recent announcements,
   hiring for ML infrastructure, and who decides on infrastructure spend. It must stop early
   when it has enough.
5. **Write.** With Haiku (structured output) from the passing findings plus
   `ABSTRACT_CONTEXT` and `ANGLE_LIBRARY`: `Brief`, `CompanyPicture`, 2 to 4 well-supported
   `Angle`s, never padded to a fixed count (each
   cites findingIds and has an email and a LinkedIn message under 300 characters) and an
   `Approach`. Drafts: plain, specific, short (under 120 words), no hype, no invented facts,
   the sender's name and Calendly link from settings when set (leave a clear
   `[your booking link]` placeholder otherwise). Every brief bullet cites real finding ids.
6. **Verify.** A second Haiku pass checks each draft sentence against the cited findings
   and the Abstract context; unsupported claims are rewritten once. Strip any finding id that
   does not exist.
7. **Save** brief, companyPicture, angles, approach; `finishResearch(id, 'done')`; event
   "Research done". On a fatal error: `finishResearch(id, 'error', message)` and an error event.
   A whole run should take about 1 to 3 minutes; put a timeout on every network call.

**Warm paths** (section 11): `startWarmPaths(ctx)` (`src/lib/paths/research.ts`) starts right
after gather, with the profile, company page and verified X handle the run read, and runs
alongside extract, the gap-fill agent and writing. It is capped at min(60 s, time left − 20 s)
and never throws. The run awaits it just before it finishes, also on a failed run, and it logs
one `tool` event that never names anyone ("Warm paths: best via someone you know (Medium,
LinkedIn)"). It never reads the lead's profile again: a failed read in the run stays failed.

`steerLead(leadId, instruction)`: classify with Haiku into `rewrite` (regenerate angles and
drafts following the instruction, keep findings and brief) or `research` (run the gap-fill
agent focused on the instruction, then rewrite brief and angles). Log a `steer` event and
finish the run the same way. Steer runs do not check warm paths.

## 7. HTTP API (owned by the api agent)

All JSON. Errors: `{ error: string }` with a 4xx/5xx status. Validate bodies with zod.

| Method and path | Body | Response |
| --- | --- | --- |
| GET /api/leads[?view=active\|unqualified] | | `{ leads: Lead[], counts: { active, unqualified } }`: at most 500 leads; `active` (the default) leaves out unqualified leads; any other view is a 400 (section 11). Each `Lead` carries `warmPath` (section 11) |
| POST /api/leads | `{ linkedinUrl, name?, companyName?, notes? }` | 201 `{ lead }`; 409 `{ error, existingId, existingStage }` (the error says "(marked unqualified)" for such a lead); starts research with `claimResearch` + `after(() => runResearch(id))` |
| GET /api/leads/[id] | | `LeadDetail` `{ lead, findings, events, paths }`; 404. `paths` is `WarmPaths` (below), or null before the first research run of a lead never checked. Polled every 2 s while research or a check runs; redoes the free part first when it is stale (section 11) |
| PATCH /api/leads/[id] | any of `stage, unqualifiedReason, notes, owner, nextStepAt, email, name, title, companyName, angles, linkedinUrl, xHandle` | `{ lead }`; logs one `stage` event in the same statement when the stage changes ("Marked unqualified[: reason]" or "Stage changed from X to Y"); `unqualifiedReason` is a 400 unless the lead is unqualified after the patch; `linkedinUrl` 409 `{ existingId, existingStage }` when another lead has that profile, and a different profile deletes the lead's warm paths; a typed `email` is saved as `manual`; `xHandle` ("@ada_kim", "ada_kim" or an x.com link; "" or null clears it) is saved without "@", 400 `bad_handle` when it is not one, and a different handle drops the cached X check and redoes the free part |
| DELETE /api/leads/[id] | | `{ ok: true }` |
| POST /api/leads/bulk | `{ action: "unqualify" \| "restore" \| "delete", ids (1 to 500), reason? }` | unqualify and restore: `{ leads, missing }`; delete: `{ deleted, missing }` (section 11) |
| POST /api/leads/[id]/research | `{ focus? }` (up to 1,200 characters) | 202 `{ ok: true }`; 409 if already running; 429 over the run caps. A focus logs a `steer` event "Re-run: <focus>" |
| POST /api/leads/[id]/steer | `{ instruction }` | 202 `{ ok: true }`; 409 if running |
| POST /api/leads/[id]/sent | `{ angleId, channel: "email" \| "linkedin" }` | `{ lead }`: stage `contacted`, `lastContactedAt` now, `nextStepAt` now + `followUpDays`, `sent` event |
| POST /api/leads/[id]/events | `{ type: "copied" \| "note", message }` | `{ ok: true }` |
| POST /api/leads/[id]/hubspot | | `{ ok, contactId?, companyId?, dealId? }`; 400 when not configured |
| GET /api/settings, PUT /api/settings | `Partial<Settings>` | `{ settings }`. `xHandle` ("" or `[A-Za-z0-9_]{1,15}`; "@jane" and x.com links accepted), `instagramHandle` ("" or `[A-Za-z0-9._]{1,30}`, not an Instagram page such as `explore`) and `linkedinUrl` ("" or a linkedin.com/in/ URL) are saved cleaned; 400 `{ field }` when one is not valid. A new X handle forgets your X lists, a new LinkedIn URL your roles and schools; either way every lead's free part is redone after the reply |
| GET /api/status | | `{ providers: ProviderStatus[], model: { name, effort }, authEnabled: boolean, linkedinAccount: { state: "not_set_up" \| "connected" \| "needs_reconnect" \| "unavailable", detail } }`. `providers` has 9 rows. `linkedinAccount` is the owner's own account (section 11): no call until `UNIPILE_NETWORK_ACCOUNT_ID` is set, then Unipile's accounts list (cached 10 minutes, never LinkedIn), `unavailable` after 3 s |
| POST /api/login, POST /api/logout | `{ password }` / none | `{ ok: true }` or 401 (see 8b) |

Route handlers that start research must set `export const maxDuration = 300` and use
`after` from `next/server`.

**Warm paths** (section 11). None of these is refused on an open deploy, and no reply carries
your contact lists.

| Method and path | Body | Response |
| --- | --- | --- |
| POST /api/leads/[id]/paths | | Find warm paths / Check again: reads LinkedIn and X again even when cached, within the budgets, in about 50 s (`maxDuration` 60; one check per lead at a time). 200 `{ paths, message, outcome: "found" \| "none" }`; 400 `nothing_to_check` (no LinkedIn profile and no X handle) or `not_set_up` (nothing of yours is set up), with `paths`; 404; 409 `research_running`, `checking`, or `changed` (the lead got another LinkedIn profile during the check; nothing saved); 429 `warm_path_check_limit`: the 100 checks a day from the lead page are used (counted across the app; a check that compared nothing gives its unit back); 429 `warm_path_budget` with `paths`: every live source set up is over its budget; 502 `upstream` with `paths`: every live source set up failed and nothing else was checked; 500 `error` (the stored paths are kept). 429 and 502 still save the free part. Logs one `tool` event |
| PATCH /api/leads/[id]/paths | `{ instagramHandle: string \| null }` | `{ paths }`; "" or null clears it; 400 `bad_handle` (not `[A-Za-z0-9._]{1,30}`, or an Instagram page such as `explore`); 404; 409 `checking` |
| PATCH /api/leads/[id]/paths/[pathId] | `{ introDraft?: string \| null, asked?: boolean }` | `{ path }`. `introDraft` is at most 2,000 characters; "" or null clears it. `asked: true` sets the date once and logs a `note` event "Asked <name> for an intro"; `false` clears it. 400 `direct` (the direct path has nobody to ask); 404; 409 `marking` |
| POST /api/leads/[id]/paths/[pathId]/intro | | `{ path }` with `introDraft`: one Claude call (section 11). 400 `direct`; 404; 409 `drafting` (a draft for this lead is running); 429 `intro_budget` (100 in a rolling 24 hours); 502 `claude` when Claude declined, was cut off or failed, or the draft held a link or an email address (nothing saved; the draft still counts) |
| GET /api/network | | `NetworkStatus` (below): counts and states only |
| PUT /api/network/linkedin/connections | `{ importId: uuid, part, parts (1 to 6), rows: [slug, firstName, lastName, company, position, connectedOn][] (at most 5,000), exportedAt? }` | `{ received, total, done, connectedLeads }`. Rows are checked again here; nothing replaces the stored connections until the last part. 400 for a bad part or row (the message names the row number, never its content); 409 `replaced` (a newer upload replaced this one); 413 over 4 MB; 415 when not JSON |
| DELETE /api/network/linkedin/connections | | `{ ok: true, removed }` |
| POST /api/network/linkedin/self | | Read now: `{ readAt, roles, schools }` (counts). 400 `no_url`; 409 `busy`; 429 `too_soon` (10 minutes after a read, 2 after a failure, or the day's 10 profile reads used); 502 `failed`. `maxDuration` 300 (the Apify fallback) |
| POST /api/network/x/sync | | Refresh now: `{ following, followers, syncedAt, creditsUsed, refreshed, note }`; `refreshed` false with a `note` when the stored lists were kept. 400 `not_configured` or `no_handle`; 409 `syncing`; 429 `warm_path_budget` (no room and no lists stored); 502 `upstream` |

- `pathId` is opaque: `direct`, or `li-` or `x-` and 12 hex characters, a hash of the lead id
  and the person's key (`src/lib/paths/ids.ts`), so no name, slug or handle is ever in a URL or
  a request log. It is stable across checks (drafts and "asked" dates are kept by it) and
  differs from lead to lead. Any other id is a 404, so an id can never end like a static file
  (the proxy's matcher skips such paths). Rules 1 to 4 cover every new route; the proxy needs no
  new rule.
- A lead's reply holds at most 10 paths and 5 people at the company. Contact names never go to
  server logs, analytics or error messages.
- After an upload's last part, a removal, Read now, or a new X handle or LinkedIn URL in
  Settings, every lead's free part is redone in `after()` (SQL only, at most 20 s, most recently
  checked first; the rest when they are next opened).

Shapes (`src/lib/paths/types.ts`):

- `WarmPaths`: `{ status: "idle" | "running" | "done" | "error", startedAt, checkedAt, sources,
  linkedinShared: { count, shown } | null, paths, companyPaths, links: { linkedinMutuals,
  xFollowersYouKnow, instagram }, limits: { linkedinChecksLeft, xUsdLeft }, setup, leadFirstName,
  instagram: { handle, source: "profile" | "manual" } | null, error }`. A check that started more
  than 90 s ago reads as `error`. `sources` has one footer line per network: `{ network:
  "linkedin" | "x" | "instagram", state: "checked" | "cached" | "not_set_up" | "lead_unknown" |
  "skipped" | "failed", reason, detail, counts, at, costUsd }`, never naming anyone. `setup` is
  booleans: `linkedinConnections, linkedinProfile, linkedinAccount, x, instagram, any, xAvailable`.
- `WarmPath`: `{ id, rank, hops: 1 | 2, strength: "strong" | "medium" | "weak" | null, connector:
  { name, title, company, linkedinUrl, xHandle, leadId, leadStage } | null, links: [{ strength,
  evidence }], introDraft: { message, createdAt } | null, askedAt }`. A person at the lead's
  company has one link and `strength` null.
- `Evidence`: `linkedin_1st { since }`, `worked_together { org, fromYear, toYear }`,
  `same_school { org, fromYear, toYear }`, `works_at { org, asOf, leadLeftYear? }`,
  `mutual_follow { network: "x" }` or `follows { network: "x", who }`; `toYear` null means it
  still goes on.
- `Lead.warmPath`: `{ strength: "strong" | "medium", hops, via, network: "linkedin" | "x" |
  "mixed", connected, label, checkedAt }` or null.
- `NetworkStatus`: `{ linkedin: { connections: { count, exportedAt, uploadedAt } | null, self:
  { url, readAt, roles, schools, error } | null, account: { state: "not_set_up" | "connected" |
  "needs_reconnect" | "paused", premium, salesNavigator, pausedUntil, pauseKind, checksToday,
  checksLimit } }, x: { configured, handle, following, followers, syncedAt, running, error,
  usdToday, usdLimit }, instagram: { handle } }`. When Unipile does not answer, `account.state`
  is `needs_reconnect`; Settings also reads `GET /api/status` and says "Could not check" for
  `unavailable`.

## 8. UI (owned by the ui agent)

**Look.** Match abstract.inc: clean, white and black, calm, no gradients, no shadows beyond
a hairline, no decorative illustrations. Tokens (put them in `src/app/globals.css` with
Tailwind v4 `@theme`):

- ink `#22221f` (text, primary buttons), paper `#ffffff`, quiet `#767670` (secondary text),
  hairline `#e4e4df` (borders, dividers), wash `#f6f6f3` (hover and subtle fills),
  link `#234cd0` (links only), danger `#b42318`, success `#1f7a3f`.
- Fonts with `next/font/google`: Inter for UI text; Newsreader (serif) for the wordmark
  "Lead Engine" and page titles. Body 14-15px, comfortable line height.
- Buttons: primary = ink background, white text, 8px radius, 36px tall, medium weight;
  secondary = white with hairline border; ghost = text only. Clear hover and focus-visible
  states, disabled states with a tooltip that says why.
- Chips/badges: rounded-full, hairline border, 12px text. Cards: hairline border, 10px radius.
- Light mode only. Responsive down to phone width (single column).

**Pages** (all client components fetching the API; show skeletons while loading, and
friendly empty and error states):

1. **App shell**: top bar with the serif wordmark "Lead Engine", nav (Leads, Pipeline,
   Usage, Settings) and a primary "+ New lead" button.
2. **Leads `/`**: "Needs you first" list sorted with `sortNeedsYouFirst`, each row showing
   name, title at company, stage chip and next-action label (`nextAction`). Search box.
   On wide screens, a two-column layout like the mock: list on the left, the selected lead
   on the right is optional; a simple list that links to `/leads/[id]` is fine.
   An Active / Unqualified switch with counts (`/?view=unqualified`), a checkbox per row
   (Select all, Shift-click for a range) and the selection's actions: Mark unqualified (with
   an optional reason) and Delete on Active, Restore and Delete on Unqualified (section 11).
   On the Active view a plain chip follows the name for a Strong or Medium warm path:
   "Connected" for a confirmed direct tie, else "Warm path", with `warmPath.label` as its
   tooltip and screen-reader text. Search also matches the connector's name (`warmPath.via`).
3. **New lead** (`/leads/new` page or a modal): LinkedIn URL (required, validated), name,
   company, notes (textarea: "How you know them, what was said, what you want"). Submit ->
   navigate to the lead page. Handle 409 by linking to the existing lead.
4. **Lead page `/leads/[id]`**: header (name, title at company, location, LinkedIn link,
   email if found, X handle if found); chips for stage (a select to change it), owner,
   follow-up date; actions: Re-run research, Push to HubSpot (disabled with reason when not
   configured), Remove (Mark unqualified or Delete for good). An unqualified lead shows a
   notice with its reason (editable) and Restore. While research runs: a live progress panel with the
   current step and the latest events. The page polls every 2 s while research or a warm-path
   check runs. A header link, "Warm path via Priya Shah ↓" or "You're connected ↓", jumps to
   the Warm paths panel for a direct tie or a Strong or Medium path, never while research or a
   check runs. Details holds the lead's X handle (PATCH /api/leads/[id]) and Instagram handle
   (PATCH /api/leads/[id]/paths), saved on blur, with the error under the field and the typed
   value kept. Sections, in this order:
   - **Brief**: summary, bullets with small source links (finding ids -> finding url),
     pains, likely objections, questions for the first call.
   - **Warm paths** (`id="warm-paths"`, section 11): shown once the lead was researched or
     checked (a lead never researched that an upload calls Connected is checked for free on
     view, so the page agrees with the chip). States, the first that matches wins: **Not set
     up** (one sentence, Set up warm paths to `/settings#network`, and the check-yourself
     links); **Looking** (a check runs, or research runs on a lead never checked: a spinner,
     "Looking for people you both know" only when X or your LinkedIn account can run for the
     lead, else "Looking for links to Ada", the sources being checked, two skeleton rows, a
     polite status); **Ready** (never checked: Find warm paths); then what was found,
     under an error notice when the last check failed (the button then reads Try again). There
     is no locked state. Found: the direct box on the wash ("You're already connected to Ada."
     and the evidence, then Go to Angles, or Open on X for an X-only tie); "Or through someone
     you both know"; up to 3 Strong or Medium rows (else the best Weak one), then Show N more (up
     to 10). Each row opens into the chain You, connector, lead: aligned dots joined by a
     hairline, each link's evidence in quiet text and its strength as a word. People at the
     lead's company only when no path is Medium or better. None found, in words built only from
     what really ran (`noPathsCopy` in `src/lib/paths/copy.ts`): when a source of mutual
     connections ran (LinkedIn on your account, or X; checked or cached), "No one you know is
     linked to Ada yet." and exactly what was checked; otherwise "No direct link to Ada yet.",
     what was compared ("Ada is not one of your 6,208 LinkedIn connections, and you share no
     employer or school.", the second half only when both work histories were compared, else
     what would add it), "Mutual connections are not checked here." with "See mutual
     connections on LinkedIn ↗", and, for what is not set up, "To check them here, set up X or
     your LinkedIn account in Settings."; when LinkedIn says you share people it could not list,
     it says so. When something was found but no source of mutual connections ran, a quiet line
     where they would be listed says they were not checked, with the same LinkedIn link (the
     footer then leaves that link out). "Updated 2h ago" (the last check or recompute; the
     footer gives each source's own date) shows only when a source was really checked or cached. Footer: one line per network (with a Set up link where one is missing;
     lines for what is off or not set up follow the setup now, not when the paths were
     computed), the check-yourself links, and Check again, which is disabled while research or
     a check runs, when the lead has no LinkedIn profile or X handle, and once every live budget
     set up is used up. Intro requests: Draft intro request (one at a time per
     lead), "Message to Priya" with a word count, saved on blur (an emptied message is not
     saved), Copy (logged to Activity), Redraft (asks "Replace your edits?" only after an edit,
     remembered in localStorage by the lead and the opaque path id, never the text) and Mark as
     asked ("Asked Nov 25", with Undo). Details: the X and Instagram fields' placeholder is
     "username", never a person's handle.
   - **Company picture**: one-liner, headcount, growth, funding, team, hiring, robots and
     models, decision makers.
   - **Angles**: tabs, one per angle, recommended angle marked. Each tab: why this angle,
     email subject and body (editable textareas, saved with PATCH), LinkedIn message with a
     character count, buttons: Copy email, Open in Gmail (`gmailComposeUrl`), Copy LinkedIn
     message, Open LinkedIn profile, Mark as sent (POST /sent).
   - **Steer**: one input, "Tell the agent what to change or dig into", submit -> POST /steer.
   - **Findings**: all findings grouped by source, with title, text, date, link, and a toggle
     "Show filtered out" for findings that failed the criteria (show the reason).
   - **Activity**: the event timeline, newest first.
5. **Pipeline `/pipeline`**: columns by stage (`ACTIVE_STAGES`: every stage but
   unqualified), compact cards (with the Leads list's warm-path chip), a stage select on each
   card (PATCH; Unqualified asks why, then marks the lead and offers Undo), and a line "N
   unqualified leads are hidden" linking to them.
6. **Settings `/settings`**: sender name, sender email, Calendly link, email signature,
   follow-up days, criteria rules (editable list), and an Integrations panel from
   `GET /api/status` (configured or not, and why; "X follows (twitterapi.io)" is one row). Show
   the model line: "Claude Haiku 5.5, low effort".
   **Your network** (`id="network"`, between Sender and Criteria, section 11): "Research uses
   these to find people who can introduce you. Read only: nothing is posted, followed or sent."
   While no team password is set, a notice: "While Lead Engine is open to anyone with its link,
   they can see the people shown on lead pages. Set APP_PASSWORD to close it." (`OPEN_NOTICE`).
   LinkedIn: your profile URL with Read now, which uses the saved URL (disabled with "Save
   settings first." while the field is edited), then "Read Nov 25: 4 roles, 2 schools.";
   Your connections, with LinkedIn's export steps before an upload, a progress line per part,
   then "1,469 connections, export of Nov 2" with Upload a new file and Remove (a confirm that
   names the count); a file that is not the export is refused in words and nothing is sent;
   Your LinkedIn account (optional), with the risk sentence and a state: Not set up, Connected
   (free account, Premium or Sales Navigator) with "3 of 10 checks used today", Needs
   reconnecting, Paused until 3 pm, or Could not check. X: an @-prefixed handle field,
   "Following 380 · Followers 1,500 · refreshed 3h ago", Refresh now, and "From twitterapi.io:
   about $0.03 a refresh. Today $0.18 of $1.00."; without `TWITTERAPI_IO_KEY` the button is
   disabled and the page says why, and the handle can still be saved. Instagram (optional): a
   handle field and "Instagram's lists are never read." The three handles save with Save
   settings and are checked as you type; a field the server refuses shows its message under
   it. Read now, Refresh now, upload and Remove act at once, each with a busy state and the
   server's own error text.

`src/lib/api-client.ts` (ui agent) holds typed fetch helpers for every endpoint in section 7.

## 8b. Access gate (api agent + ui agent)

The app has no user accounts. When deployed it must not be open to the internet: anyone with
the URL could read leads and spend API credits. Add one shared team password:

- `APP_PASSWORD` and `SESSION_SECRET` env vars (already in `src/lib/env.ts`). When
  `APP_PASSWORD` is unset on a local run, the gate is off. On Vercel the app refuses every
  request with 503 until `APP_PASSWORD` is set, so a deploy can never be open by accident.
- Cross-site writes to `/api/*` are refused (Sec-Fetch-Site / Origin check), research and
  steer runs are capped at 20 per hour and 25 per day (`RUN_LIMIT_PER_HOUR`,
  `RUN_LIMIT_PER_DAY`; each slot reserved atomically in `le_run_starts`, migration 003), and
  a run stuck in `running` for over 6 minutes is
  marked failed so it can be retried.
- `src/lib/auth.ts` (api agent): create and verify a signed session cookie with Web Crypto
  HMAC-SHA256 over an expiry timestamp using `SESSION_SECRET` (works in the proxy runtime);
  constant-time comparison of the password; cookie `le_session`, HttpOnly, Secure in
  production, SameSite=Lax, 30-day expiry.
- `src/proxy.ts` (api agent): Next 16 renamed middleware to proxy; read
  `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` first. Redirect
  unauthenticated page requests to `/login?next=...`; answer unauthenticated `/api/*`
  requests with 401 JSON; always allow `/login`, `/api/login`, `/_next/*`, favicon and
  public files.
- `POST /api/login { password }` sets the cookie (small fixed delay on failure);
  `POST /api/logout` clears it (api agent).
- `src/app/login/page.tsx` (ui agent): a calm, centred password form in the same style,
  then redirect to `next`. Add a "Log out" link in the app shell when the gate is on.

## 9. File ownership

| Owner | Files |
| --- | --- |
| linkedin agent | `src/lib/providers/linkedin.ts`, `scripts/test-linkedin.ts` |
| apollo-hunter agent | `src/lib/providers/apollo.ts`, `src/lib/providers/hunter.ts`, `scripts/test-apollo-hunter.ts` |
| exa-hub agent | `src/lib/providers/exa.ts`, `src/lib/providers/huggingface.ts`, `src/lib/providers/abstract.ts`, `scripts/test-exa-hub.ts` |
| x agent | `src/lib/providers/xsearch.ts`, `scripts/test-x.ts` |
| research agent | `src/lib/claude.ts`, `src/lib/research/**`, `scripts/test-research.ts` |
| api agent | `src/app/api/**`, `src/lib/providers/hubspot.ts`, `src/lib/auth.ts`, `src/proxy.ts`, `scripts/test-api.ts` |
| ui agent | `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/app/leads/**`, `src/app/pipeline/**`, `src/app/settings/**`, `src/app/login/**`, `src/components/**`, `src/lib/api-client.ts`, `public/**` |

## 10. Definition of done (every builder)

- Your files compile: `npx tsc --noEmit` shows no errors in files you own.
- Your code runs: a live test script for your module passes, within the cost limits.
- No secrets printed. No edits outside your files.
- Your final report lists: files written, what you tested and the output, what you could not
  test and why, anything another builder must know, and any foundation change you need.

## 11. Additions after V1: import, email, usage, unqualified leads, warm paths

**Data** (migrations 004 and 005, additive):

- `le_leads.linkedin_url` and `linkedin_slug` are nullable (imported contacts). New columns:
  `source` (`csv | sheet | hubspot`, null for single adds), `hubspot_contact_id` (unique when
  set), `email_status` (`found | verified | guess | imported | manual`), `import_key`
  (`lower(name)|lower(company)` as imported, for re-imports of rows with no other key), and an
  index on `lower(email)`. `Lead` gains `source`, `hubspotContactId` and `emailStatus`.
- `le_quota_uses (kind, units, lead_id, created_at)`: daily budgets with no row of their own,
  reserved in one transaction behind an advisory lock like `le_run_starts`. `import` counts
  new leads (`IMPORT_LIMIT_PER_DAY`, default 2,000). `email_lookup` counts Hunter
  half-credits (`HUNTER_CREDITS_PER_DAY`, default 10 credits): a lookup reserves 1.5 credits,
  then keeps only what Hunter charged. Find email and research's email step share it.
- Research and Find email never replace an `imported` or `manual` address.

**Routes:**

| Method and path | Body | Response |
| --- | --- | --- |
| POST /api/leads/import | `{ source, rows }` (at most 1,000 rows, 4 MB) | `{ created, createdIds, createdRows, duplicates, skipped }`; 429 `{ limit, remaining, wanted }` over the import budget (nothing is added). Never starts research; logs a `created` event `{ source }` |
| POST /api/import/sheet | `{ url }` (docs.google.com only) | `{ headers, rows, total, truncated, headerRow }`: the first 5,000 rows; the CSV is parsed only that far |
| GET /api/import/hubspot?limit= | | `{ headers, rows, total, more, linkedinProperties, warnings }` (up to 2,000); 403 `needs_password` on Vercel while `APP_PASSWORD` is unset; 400 `not_connected` without a token |
| POST /api/leads/[id]/email | | `{ email, emailStatus, emailConfidence, message, creditsUsed, lead }`; 409 for an address the team added; 429 `hunter_budget` when the day's Hunter credits are used up |
| GET /api/usage?window= | | `UsageResponse` (summary, leads, daily, operations, runs) |
| GET /api/usage/calls?window=&sort=&provider=&operation= | | `{ calls, total }` (a deleted lead's calls show "Deleted lead") |
| GET /api/usage/balances[?refresh=1] | | `{ balances, checkedAt, cached, refreshableAt }` (cached 60 s, refresh at most every 30 s) |
| GET /api/usage/export?window= | | CSV with a BOM; cells that start like a formula get a leading apostrophe |

**Leads without LinkedIn:** identify searches Exa (up to 2 searches) and takes a profile only
when the name matches and so does the company or the email's domain; otherwise the run stops
with a message asking for the URL.

**HubSpot push:** a contact found by its record id is only written to when it has the lead's
email or first and last name; otherwise the push falls back to the email or name match.

**Usage tab (`/usage`):** a run starts at its `le_run_starts` row and ends at the lead's first
`done` event, or else its last `error` event, within 6 minutes and before the next run. Its
cost is the lead's ledger rows from start to end plus 15 s. The proxy has rules 1 to 4 only;
the old local-only `/admin` panel is gone.

**Events:** `steer` for "Re-run: ...", `tool` for email lookups and "Found their LinkedIn by
search: ...", `created` with `{ source }` for imports.

**Unqualified leads (migration 006, additive):**

- Stage `unqualified`, last in `STAGES` and apart from `lost` (a real opportunity that did
  not close). `ACTIVE_STAGES` is every other stage. New columns: `unqualified_at` (set
  exactly while the stage is `unqualified`), `unqualified_reason` (1 to 200 characters, or
  null) and `stage_before_unqualified` (one of the active stages). Four named checks hold
  these rules on every write; two partial indexes serve the two lists (500 rows each).
- Marking keeps the lead and its research; the Leads and Pipeline pages leave it out, and an
  import that matches it reports a duplicate "(marked unqualified)" with `existingStage`.
  Marking a lead that is already unqualified keeps its date and earlier stage and logs no
  second event. Research never moves a lead out of `unqualified`.
- Restore (`restoredStage` in `src/lib/qualify.ts`, the same rule in SQL in
  `src/lib/repo/qualify.ts`) goes back to the stage before, moved on only as research would
  have moved it: a lead marked mid-run goes to `researching` while the run goes, else
  `researched` or `new`.
- `POST /api/leads/bulk` takes 1 to 500 UUIDs, lowercased and deduplicated, answered in the
  order sent. Each action is one statement that locks its rows in id order (so two bulk
  actions never deadlock) and writes its `stage` events with it: "Marked unqualified[:
  reason]" `{ from, to, reason }` and "Restored from unqualified to <Stage>". Delete is for
  good, like DELETE /api/leads/[id]. Each action that changed something logs one server line.
- Rolling back to code from before 006 needs every unqualified lead restored first (README,
  "Rolling back"); the migration can stay applied.
- Analytics: `leads_unqualified { count, reason key or "none", surface }`,
  `leads_restored { count, surface }`, `leads_deleted { count, surface }`.

**Warm paths (migration 007, additive):** who can introduce the owner to a lead. "You" is the
sender in Settings; there are no teammates in this version. The engine is `src/lib/paths/`; the
routes are in section 7 and the screens in section 8.

- **Data.**
  - `le_network_contacts` is your side of the graph: `network` (`linkedin | x`), `relation`
    (`connection | connection_pending | following | follower`), `external_id` (the LinkedIn
    slug as `linkedinSlug()` makes it, or the numeric X id), `handle`, `name`, `name_key`
    (LinkedIn: the name's words as `nameTokens` reads them, accents dropped, so an X account's
    first and last name find the connection by whole words), `company`,
    `position`, `profile_url`, `company_key` (`normaliseName(company)`), `followers_count` (X),
    `connected_on` (LinkedIn), `import_id`, `seen_at`. Unique on `(network, relation,
    external_id)`, with a partial index on `(network, company_key text_pattern_ops)`. It never
    holds an email.
  - `le_network_sources`: one row per source (`linkedin_csv | linkedin_self | linkedin_account |
    x_self | x_following | x_followers`) with `status` (`ok | running | error`), `detail`,
    `item_count`, `cursor`, `data` (the upload's dates, your roles and schools, your account's
    flags and pause, your X counts; never a token or a cookie), `synced_at` (which marks a change
    of your network) and `updated_at`.
  - `le_warm_paths`: one row per lead, deleted with it. `status` (`idle | running | done |
    error`), `target` (the lead's slug, public and member ids, up to 12 roles, 5 schools, the
    company's size, X and Instagram handles), `linkedin_live`, `x_live`, `paths` (up to 10),
    `company_paths` (up to 5), `sources` (the footer lines, each with what it compared:
    `mutuals` and, on the LinkedIn line, `history`), `setup` (which of your sources were set up
    when the paths were computed, booleans only), `intros` (drafts and "asked" dates by opaque
    path id, so they outlive a recompute), `error`, `started_at`, `computed_at`, `updated_at`.
  - `le_leads.warm_path`: the list summary (`Lead.warmPath`), the best Strong or Medium path or
    null. Small, so the Leads list needs no join.
  - The kind check on `le_quota_uses` gains `warm_path_linkedin`, `warm_path_x`, `intro_draft`
    and `profile_read`; it is dropped and added again in the same transaction.
  - Safe for the code deployed before it: that code never reads the new tables or column (its
    inserts leave `warm_path` null), and the kind check still accepts `import` and
    `email_lookup`. The runner splits on a semicolon at a line end, so 007 is plain statements:
    no DO block, and no comment line ends in a semicolon.
- **Types.** `Lead.warmPath`; `Settings.xHandle`, `instagramHandle` and `linkedinUrl` (strings,
  default `""`); `LeadDetail.paths`. The client-safe types are in `src/lib/paths/types.ts`.
- **A check** (`findWarmPaths`, which never throws; one check per lead at a time):
  1. The lead's side: from the research run, else `le_warm_paths.target`. For a lead researched
     before warm paths existed: the profile its research stored (`le_raw`, when it is the lead's
     current URL), else one Unipile-only read of the lead's profile on the research account, with
     no Apify fallback, within the profile-read budget.
  2. The free part, SQL and plain code: the lead's slug, public id or member id in your
     connections (LinkedIn 1st degree); your roles and schools against the lead's, with
     overlapping dates (the same LinkedIn company page, else names by whole words); your
     connections at the lead's current company, or a company the lead left within 8 years
     ("company people"). Company people come only from the roles read from the lead's profile,
     never from the company name, which anyone can edit on an open deploy. Every name comparison
     (employers, schools, company people, "works with Ada at Acme now", the X bio tie) goes by
     whole words (`sameCompanyWords`: the same key, or the shorter name ends where a word of the
     longer one ends: "Acme" and "Acme Robotics", "J.P. Morgan" and "JPMorgan Chase"; never "Heli"
     for "Helix Motion" or "Meta" for "Metaview"). Placeholder employers ("Self-employed",
     "Freelance", "Stealth Startup", "Confidential", `isPlaceholderEmployer`) match nothing. Each
     company-people row names the connection's own company as exported, with the year the lead
     left a past company. School years are academic years: one class leaving as the next arrives
     is no overlap. The company size counts only for the company whose page was read (the lead's
     main current role, `target.companySizeKey`), never for their other current roles.
  3. LinkedIn on your own account (step 2, `UNIPILE_NETWORK_ACCOUNT_ID`, `linkedin-check.ts`):
     `GET /users/{member id or slug}?notify=false` with no sections (one request) for
     `network_distance` and `shared_connections_count`. For `SECOND_DEGREE` only, one page (10)
     of `POST /linkedin/search` with `{ api: "classic", category: "people", network_distance:
     [1], connections_of: [member id] }`, or LinkedIn's own shared-connections URL when
     `le_network_sources.linkedin_account.data.searchForm` is `"url"` (set by hand). Once,
     `GET /users/me` for the Premium and Sales Navigator flags. The search's people are used only
     when every item is `DISTANCE_1`, the echoed config carries the member id, and the total is
     at most the shared count + 5 (250 when the count is unknown); otherwise the footer says so
     and the link stays. Never Apify, never the research account.
  4. X through twitterapi.io (`TWITTERAPI_IO_KEY`, your handle, and the lead's verified handle;
     `x-check.ts`): your follows (the newest 5,000, with names) and follower ids (up to 20,000),
     refreshed at most daily (a read cut short never shrinks them); then the lead's profile
     (stop when private, suspended or not found), their newest 5,000 follows, and for the people
     from your lists among them, whether they follow the lead back: the lead's follower ids (20,000
     followers or fewer) or up to 50 follow checks, whichever costs less. Up to 30 connectors
     are kept. An X account joins a LinkedIn person's row only when the names match and its bio
     or link names their slug or company; the bio is never stored. 15 s a call, 45 s for the X
     part; a check cut short (time, a failed page, no budget left) is marked partial; one that
     stopped at the 5,000 cap is not, and its line says "Only their newest 5,000 of 8,000 follows
     were read."
  5. LinkedIn and X run side by side. Then one row per person, scored and ranked, written with
     the list summary in one statement.
  - Instagram is a link and a handle only (from the profile's websites, or typed on the lead
    page); nothing ever requests Instagram. The check-yourself links are LinkedIn's
    shared-connections search for the member id (else the profile),
    `x.com/<handle>/followers_you_follow` and `instagram.com/<handle>/`. Neither LinkedIn nor X
    documents the first two.
- **Ranking** (`score.ts`). Points per piece of evidence on a link: worked together 5 (an overlap
  of 12 months or more, ended within 8 years or still going, at a company known to have 1,000
  employees or fewer), else 3; both work there now, start dates unknown, 3; LinkedIn 1st degree
  3; a mutual X follow 3; the same school with overlapping years 2 (unknown years: shown, 0); a
  one-way follow that counts ("Follows you", "Ada follows them") 1, or 0 above 50,000
  followers; the other two directions 0, shown only next to other evidence. A link sums its
  points, capped at 8: 5 or more is Strong, 3 to 4 Medium, 1 to 2 Weak, and a link at 0 drops
  the path. A path is as strong as its weaker link. Order, each rule breaking only the ties of
  the one before: direct before two-hop; Strong, Medium, Weak; the weaker link's score; the
  total; the most recent shared year (still going first); the provider's own order; name A to
  Z. One row per person, at most two hops; 10 paths and 5 company people are kept. Points are
  never shown. The list summary is the best Strong or Medium path, looking past a weak direct
  overlap that ranks first (`summary.ts`). After an upload, one statement gives every lead in
  your connections a "Connected" summary until its free part is redone.
- **Budgets** (`le_quota_uses`, each kind behind its own advisory lock; `RUN_LOCK_KEY` is
  74_221_001, `import` 74_221_002, `email_lookup` 74_221_003):
  - `warm_path_linkedin` (74_221_004): checks on your account,
    `WARM_PATH_LINKEDIN_CHECKS_PER_DAY` (default 10). `reserveQuota` gains a minimum gap, 120 s
    for this kind, checked under the same lock (a refusal says `reason: "gap"` with `waitMs`).
    The unit is kept once LinkedIn was called and given back when nothing was sent. A 429 pauses
    your account for 24 hours, a 401 or 5xx for an hour, stored in `linkedin_account` so every
    instance respects it.
  - `warm_path_x` (74_221_005): twitterapi.io credits, `WARM_PATH_X_USD_PER_DAY` × 100,000
    (default $1; cents allowed, such as 0.5). Each step reserves its worst case and settles to the credits counted from the
    answers; a call that failed after it was sent keeps the most it could have cost. A lead
    reserves 15,000.
  - `intro_draft` (74_221_006): 100 in a rolling 24 hours, fixed. Given back only when the
    Claude key is missing or rejected.
  - `profile_read` (74_221_007): 10 in a rolling 24 hours, fixed: LinkedIn profile reads on the
    research account outside research runs (Read now, and in a check from the panel your own
    profile or the profile of a lead researched before warm paths existed). A lead researched
    before warm paths first uses the profile its research stored (`le_raw` 'linkedin.profile',
    only when it is the lead's current URL), so it needs no read; the free recompute after an
    upload, Read now or a settings save captures those leads' side first (SQL only).
  - `warm_path_check` (74_221_008): 100 in a rolling 24 hours, fixed: POST /api/leads/[id]/paths
    from the panel. Given back when the check compared nothing. Without it, a loop of PATCH
    linkedinUrl and POST paths would test any list of profiles against your connections for free.
  - The connections upload's waiting rows and its last step sit behind their own advisory lock
    (74_221_009): parts sent at once cannot pass the per-upload cap, and the last step (replace
    the stored connections, promote the waiting rows, write the record) is one transaction that a
    retried or doubled last part finds already done, so it changes nothing.
  - 0 in either env var pauses that budget. Over budget, research skips that source with a
    footer line; the button saves the free part and answers 429 only when every live source set
    up is over budget.
- **Caching.** Your X lists 24 hours. Your own profile 30 days; after a failed read, checks wait
  24 hours, and a new URL clears that. LinkedIn results 30 days (a 2nd-degree check whose search
  never ran is not reused, and one whose search failed is reused for an hour). X results 7 days (1 hour when cut short before the lead's follows
  were read). The Unipile accounts list 10 minutes in memory. Check again reads LinkedIn and X
  again whatever their age, within the budgets.
- **Invalidation.**
  - A different LinkedIn profile on the lead deletes its `le_warm_paths` row and clears
    `warm_path` in the same statement (clearing the URL counts; a first profile keeps the row).
  - A different X handle on the lead drops `x_live` and redoes the free part.
  - A new X handle in Settings forgets your X lists, every cached X check, every path that may
    name an X account, and the X-only intro drafts. A new LinkedIn URL drops your roles and
    schools.
  - An upload's rows wait as `connection_pending`, which nothing matches, until its last part
    arrives; then they replace your connections in one transaction. A newer upload's part 1
    drops an older upload's waiting rows. Remove deletes your connections, every path but the
    X-only ones, every company person, `linkedin_live` and the intro drafts of LinkedIn people
    (`li-` ids), and clears every list summary.
  - After an upload, a removal, Read now, or a new X handle or LinkedIn URL in Settings, every
    lead's free part is redone in `after()` (SQL only, most recently checked first, at most
    20 s; the rest when opened).
  - `GET /api/leads/[id]` redoes the free part when it is stale: your network changed after
    `computed_at` (a source's `synced_at`), what is set up changed (`setup`: a key added or
    removed on the server, a handle or URL in Settings, so a line for what is off or not set up
    always follows the setup now; cached live results are kept), or the lead's X handle, your X
    handle or the lead's profile changed, or an upload gave the lead a chip but it was never
    checked (even when research never ran: the LinkedIn URL is enough for the direct box). Never
    while research or a check runs. It is saved only over the row version it read (`xmin`), or as a
    new row when there was none, so it never overwrites a newer write or recreates a deleted
    row, and it runs at most once per change. A second view waits for the recompute already
    running.
- **Privacy and the open deploy.** Warm paths and Your network work with `ALLOW_OPEN_ACCESS=1`:
  no locked state, no `needs_password`. No route returns your contact lists, a lead's reply is
  capped at 10 paths and 5 company people, and names never go to server logs, analytics or
  error messages, nor into a URL (path ids are opaque). The `tool` events of a check never name
  anyone and, like the panel, never say "none found" unless a source of mutual connections ran
  ("Warm paths: no direct link (checked 6,208 LinkedIn connections; mutual connections not
  checked)"); only Copy and Mark as asked write the person's name, into the lead's own
  Activity. Settings shows `OPEN_NOTICE` while
  `authEnabled` is false.
- **Unipile accounts.** Two roles, one cooldown each (section 5). Research never reads
  through `UNIPILE_NETWORK_ACCOUNT_ID`; with two or more LinkedIn accounts and no
  `UNIPILE_ACCOUNT_ID`, or with the owner's account set and no pin, research refuses to guess
  and falls back to Apify. Pin `UNIPILE_ACCOUNT_ID` before setting `UNIPILE_NETWORK_ACCOUNT_ID`.
- **Intro drafts** (`intro.ts`): one `generateObject` call (Haiku 5.5 at low effort,
  `maxTokens` 1000, 30 s). Inputs, each wrapped with `wrapData`: the sender's name (else
  `[your name]`), the connector, both links' evidence, the lead's name, title and company, the
  Brief summary, the recommended angle's reasoning and up to 3 findings that pass your criteria.
  Rules: under 90 words; greet the connector by first name; the ask first, then one why-now
  sentence tied to one fact; a paragraph to forward as it is; "No worries if it's not a fit."
  and the sender's name; no more closeness than the evidence shows; never follows, connections
  or how the tie was found; no links. A draft with a link or an email address in it is refused.
  Copy logs a `copied` event and Mark as asked a `note` event. Next actions and Angles do not
  change.
- **Usage.** Provider `twitterapi` (operations `user-info`, `followings`, `followers-ids` and
  `follow-check`; units `requests`, `credits`, `items`; cost `estimated`). Your account's
  Unipile calls are `network-profile`, `network-search` and `network-me`, free, and
  `ledger-stats` counts them apart (`networkRequestsToday`) from the research account's ~100 a
  day. Lead counters: `xGraphCredits`, `linkedinPathChecks`. The Usage tab gains a twitterapi.io
  card ("$0.18 of $1.00 X budget used today", this month's estimated spend, no balance call); the
  Unipile card splits into Research account, Your account and Warm-path checks once
  `UNIPILE_NETWORK_ACCOUNT_ID` is set (`unipileSplit`, `ownAccountCalls` in
  `src/components/usage/unipile.ts`); twitterapi.io is drawn inside "Other" on the chart
  (`otherLabels`); the per-lead twitterapi.io column shows credits.
- **Analytics** (ids, counts and enums only; `handle` joins `CONTENT_KEY_RE`):
  `warm_paths_checked { leadId, found, best, trigger }`, `warm_path_opened { leadId, rank,
  strength, hops }`, `warm_path_link_opened { leadId, network, kind }`,
  `warm_path_intro_drafted { leadId, rank, ok }`, `warm_path_intro_copied { leadId, rank,
  length }`, `warm_path_marked_asked { leadId, rank }`, `network_connections_uploaded { count }`,
  `network_x_synced { following, followers }`. `SETTINGS_FIELDS` gains the three new fields.
- **Modules.** `src/lib/paths/` (`types`, `engine`, `build`, `score`, `overlap`, `target`,
  `links`, `copy`, `sources`, `summary`, `intro`, `ids`, `csv`, `linkedin-check`, `x-check`,
  `network`, `research`); `src/lib/providers/xgraph.ts` and `unipile-accounts.ts`; `src/lib/repo/paths.ts`
  and `network.ts`; `src/lib/linkedin-url.ts` (client-safe `linkedinSlug` and
  `normaliseLinkedinUrl`; `http.ts` re-exports them); `src/app/api/_lib/paths.ts`;
  `src/components/lead/warm-paths.tsx`, `warm-chip.tsx` and `handles.tsx`;
  `src/components/settings/network.tsx`; `src/components/usage/unipile.ts`.
- **Tests.** `scripts/test-paths.ts`: pure rules, the CSV parser, the providers against mocked
  APIs, the repo, the engine end to end and the research hook (`--unit`: the first two). Its
  database part and `test-api.ts` section 7 write `le_settings` and `le_network_*`, so they run
  only against a local test database (`DATABASE_URL` on a `.fake-neon.test` host) and fail one
  check anywhere else. `test-usage-tab.ts` section 7 covers the new cards and rows.
