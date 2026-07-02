/**
 * Project catalog-declared models that pi does NOT ship into a models.json that
 * pi's ModelRegistry can merge (custom wins by provider+id).
 *
 * A model is projected when it is flagged `custom: true` in the catalog. For the
 * default catalog (every model is pi-shipped) there is nothing to project and
 * this returns undefined — so ModelRegistry.create(authStorage, undefined)
 * behaves exactly as before.
 *
 * NOTE: pi's models.json entry schema (context window, api family, capability
 * flags) must be confirmed against the installed pi version before enabling a
 * genuinely non-pi-shipped provider model; until then, only `custom` models are
 * emitted and the minimal shape below is used.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { catalog, platformDir } from "@pp/core";

interface ProjectedModel {
  provider: string;
  id: string;
  input_per_1m: number;
  output_per_1m: number;
}

let _cachedPath: string | null | undefined;

/** Returns the models.json path, or undefined when there is nothing custom to project. */
export function projectCatalogModelsJson(): string | undefined {
  if (_cachedPath !== undefined) return _cachedPath ?? undefined;

  const c = catalog();
  const models: ProjectedModel[] = [];
  for (const [providerId, p] of Object.entries(c.providers)) {
    const piProvider = p.pi_provider ?? providerId;
    for (const [id, m] of Object.entries(p.models)) {
      if (m.custom) {
        models.push({ provider: piProvider, id, input_per_1m: m.input_per_1m, output_per_1m: m.output_per_1m });
      }
    }
  }

  if (models.length === 0) {
    _cachedPath = null;
    return undefined;
  }

  try {
    const dir = platformDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "models.json");
    writeFileSync(path, JSON.stringify({ models }, null, 2), "utf8");
    _cachedPath = path;
    return path;
  } catch {
    // Best-effort: if projection fails, fall back to pi's built-in registry.
    _cachedPath = null;
    return undefined;
  }
}

/** Test seam. */
export function resetProjectedModelsJson(): void {
  _cachedPath = undefined;
}
