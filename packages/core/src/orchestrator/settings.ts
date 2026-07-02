/**
 * Platform settings key/value store (v8 / M5c). A tiny JSON kv table for
 * operator-configured platform state that isn't a first-class orchestration
 * row — currently the budget caps set from the UI.
 */
import { db } from "../db/database.js";

export function getPlatformSetting<T = unknown>(key: string): T | null {
  const row = db().prepare("SELECT value_json FROM platform_settings WHERE key = ?").get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export function setPlatformSetting(key: string, value: unknown): void {
  db()
    .prepare("INSERT OR REPLACE INTO platform_settings (key, value_json) VALUES (?, ?)")
    .run(key, JSON.stringify(value));
}

/** A configured spend cap (mirrors shared/api-types BudgetCap). */
export interface BudgetCap {
  scope: string;
  limit_usd: number;
  warn_pct: number;
  block_pct: number;
}

const BUDGET_CAPS_KEY = "budget_caps";

export function getBudgetCaps(): BudgetCap[] {
  return getPlatformSetting<BudgetCap[]>(BUDGET_CAPS_KEY) ?? [];
}

export function setBudgetCaps(caps: BudgetCap[]): BudgetCap[] {
  setPlatformSetting(BUDGET_CAPS_KEY, caps);
  return caps;
}
