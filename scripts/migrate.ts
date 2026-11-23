/**
 * Applies db/migrations/*.sql in order, once each, recording them in le_migrations.
 * Run: npm run migrate   (reads DATABASE_URL from .env.local)
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = neon(url);

/** Split a migration file into statements on semicolons at line ends. */
function statements(text: string): string[] {
  return text
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

async function main() {
  await sql.query(
    "create table if not exists le_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set((await sql.query("select name from le_migrations")).map((r) => String(r.name)));
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }
    const stmts = statements(readFileSync(path.join(dir, file), "utf8"));
    await sql.transaction([
      ...stmts.map((s) => sql.query(s)),
      sql.query("insert into le_migrations (name) values ($1)", [file]),
    ]);
    console.log(`apply ${file} (${stmts.length} statements)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
