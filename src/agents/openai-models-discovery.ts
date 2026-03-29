import type { ModelDefinitionConfig } from "../config/types.js";

type OpenAIModelEntry = {
  id: string;
  owned_by?: string;
  created?: number;
};

type OpenAIListModelsResponse = {
  object?: string;
  data?: OpenAIModelEntry[];
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Fetch available models from any OpenAI-compatible `/v1/models` endpoint.
 * Returns null on failure so callers can fall back to static lists.
 */
export async function discoverOpenAICompatibleModels(params: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Filter predicate applied to each model entry before inclusion. */
  filter?: (entry: OpenAIModelEntry) => boolean;
}): Promise<ModelDefinitionConfig[] | null> {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return null;
  }

  const { baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, filter } = params;

  const url = baseUrl.replace(/\/+$/, "");
  const modelsUrl = url.endsWith("/models") ? url : `${url}/models`;

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey?.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    const response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as OpenAIListModelsResponse;
    const data = body?.data;
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of data) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id || seen.has(id)) continue;
      if (filter && !filter(entry)) continue;
      seen.add(id);

      models.push({
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
      });
    }

    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/**
 * Build select options from discovered models for the configure wizard.
 * Prepends pinned models at the top (preserving order), appends a "custom" entry.
 */
export function buildDiscoveredModelOptions(params: {
  discovered: ModelDefinitionConfig[];
  pinnedIds?: string[];
  customLabel?: string;
}): Array<{ value: string; label: string }> {
  const { discovered, pinnedIds = [], customLabel = "手动输入模型 ID" } = params;

  const idSet = new Set(discovered.map((m) => m.id));
  const options: Array<{ value: string; label: string }> = [];
  const added = new Set<string>();

  for (const id of pinnedIds) {
    if (idSet.has(id) && !added.has(id)) {
      added.add(id);
      options.push({ value: id, label: id });
    }
  }

  for (const model of discovered) {
    if (!added.has(model.id)) {
      added.add(model.id);
      options.push({ value: model.id, label: model.id });
    }
  }

  options.push({ value: "custom", label: customLabel });
  return options;
}
