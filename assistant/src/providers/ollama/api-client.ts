import { getLogger } from "../../util/logger.js";

const log = getLogger("ollama-api-client");

export type OllamaCapability =
  | "completion"
  | "vision"
  | "tools"
  | "thinking"
  | "embedding";

export type OllamaTagsEntry = {
  name: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
};

export type OllamaShowResponse = {
  capabilities?: OllamaCapability[];
  /** Ollama returns this as snake_case `model_info` in the wire payload. */
  model_info?: Record<string, unknown>;
  details?: {
    family?: string;
    parameter_size?: string;
  };
};

export type DiscoveredModel = {
  tag: string;
  capabilities: OllamaCapability[];
  contextLength: number | null;
  parameterSize: string | null;
};

export type FetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const TAGS_TIMEOUT_MS = 3000;
const SHOW_TIMEOUT_MS = 3000;
const SHOW_CONCURRENCY = 4;

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as T;
    return { ok: true, value: body };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listOllamaModels(
  baseUrl: string,
): Promise<FetchResult<OllamaTagsEntry[]>> {
  const result = await fetchJson<{ models?: OllamaTagsEntry[] }>(
    `${baseUrl.replace(/\/$/, "")}/api/tags`,
    { method: "GET" },
    TAGS_TIMEOUT_MS,
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.models ?? [] };
}

export async function showOllamaModel(
  baseUrl: string,
  name: string,
): Promise<FetchResult<OllamaShowResponse>> {
  return fetchJson<OllamaShowResponse>(
    `${baseUrl.replace(/\/$/, "")}/api/show`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    SHOW_TIMEOUT_MS,
  );
}

/**
 * Call /api/show for every tag with a concurrency cap. Failures are logged
 * and the model is skipped (returned list may be shorter than input).
 */
export async function describeAllModels(
  baseUrl: string,
  tags: OllamaTagsEntry[],
): Promise<DiscoveredModel[]> {
  const results: DiscoveredModel[] = [];
  let cursor = 0;
  const workers = Array.from({ length: SHOW_CONCURRENCY }, async () => {
    while (cursor < tags.length) {
      const i = cursor++;
      const tag = tags[i];
      const show = await showOllamaModel(baseUrl, tag.name);
      if (!show.ok) {
        log.warn(
          { tag: tag.name, error: show.error },
          "ollama /api/show failed",
        );
        continue;
      }
      results.push(toDiscoveredModel(tag, show.value));
    }
  });
  await Promise.all(workers);
  return results;
}

function toDiscoveredModel(
  tag: OllamaTagsEntry,
  show: OllamaShowResponse,
): DiscoveredModel {
  return {
    tag: tag.name,
    capabilities: show.capabilities ?? [],
    contextLength: extractContextLength(show.model_info),
    parameterSize:
      tag.details?.parameter_size ?? show.details?.parameter_size ?? null,
  };
}

function extractContextLength(
  model_info: Record<string, unknown> | undefined,
): number | null {
  if (!model_info) return null;
  for (const [key, value] of Object.entries(model_info)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return null;
}
