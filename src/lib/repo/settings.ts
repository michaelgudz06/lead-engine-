import "server-only";
import { query } from "../db";
import { DEFAULT_SETTINGS, type Settings } from "../types";

const KEY = "app";

export async function getSettings(): Promise<Settings> {
  const rows = await query<{ value: Partial<Settings> }>("select value from le_settings where key = $1", [KEY]);
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(await getSettings()), ...patch };
  next.criteria = (next.criteria ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 30);
  next.followUpDays = Math.max(1, Math.min(30, Math.round(Number(next.followUpDays) || DEFAULT_SETTINGS.followUpDays)));
  await query(
    `insert into le_settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}
