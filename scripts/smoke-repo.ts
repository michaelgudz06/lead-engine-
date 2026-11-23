import { createLead, getLead, deleteLead, addUsage, updateLead } from "../src/lib/repo/leads";
import { insertFindings, listFindings } from "../src/lib/repo/findings";
import { addEvent, listEvents } from "../src/lib/repo/events";
import { getSettings } from "../src/lib/repo/settings";

async function main() {
  const lead = await createLead({ linkedinUrl: "https://www.linkedin.com/in/smoke-test-lead-xyz/", notes: "smoke" });
  await addUsage(lead.id, { claudeInputTokens: 100 });
  await addUsage(lead.id, { claudeInputTokens: 50, xPosts: 3 });
  await updateLead(lead.id, { angles: [{ id: "a", name: "A", reasoning: "r", findingIds: [], email: { subject: "s", body: "b" }, linkedinMessage: "m" }] });
  const f = await insertFindings(lead.id, [{ source: "notes", kind: "other", text: "hello" }, { source: "exa", kind: "news", text: "world", url: "https://x.com" }]);
  await addEvent(lead.id, "created", "Lead created");
  const got = await getLead(lead.id);
  console.log("usage", got?.usage, "angles", got?.angles.length, "findings", (await listFindings(lead.id)).length, f.length, "events", (await listEvents(lead.id)).length);
  console.log("settings criteria", (await getSettings()).criteria.length);
  console.log("deleted", await deleteLead(lead.id));
}

main().catch((e) => { console.error(e); process.exit(1); });
