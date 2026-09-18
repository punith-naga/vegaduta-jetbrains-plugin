// Zero-config local inference: find the server the user is already running
// instead of asking them to type a URL they do not know.
//
// Three products own the local OpenAI-compatible ports in practice (Ollama,
// LM Studio, llama.cpp's own server) and each of them pins a default port, so
// a probe of three fixed origins covers almost every user who has anything
// running at all. Anyone who moved the port still configures it by hand - this
// is a convenience layer, never the only way in.
//
// RULE 0 NOTE (same carve-out as edge/ollamaEngine.ts and
// agent/openAiCompatibleModel.ts): every 127.0.0.1 below is the USER'S OWN
// inference server on their own machine, not a browser-facing platform URL or
// a token issuer, so the no-localhost rule does not apply to these. Nothing in
// this file may ever be used to default a platform URL.
//
// Typed-failure contract, as everywhere else in this folder: nothing here
// throws. A failed probe is an absent result, not an exception.

/** Probes are fired concurrently, so this is the whole discovery budget, not a
 * per-endpoint cost. Kept short because a client calls this on startup and a
 * closed port on loopback refuses immediately - the timeout only matters for
 * the pathological case of something accepting the connection and then
 * stalling. */
const PROBE_TIMEOUT_MS = 1_200;

export interface LocalEndpoint {
  /** Product name, shown to the user as-is. */
  label: string;
  /** Origin only, no path and no trailing slash. */
  baseUrl: string;
  /** One line telling a user who has nothing running how to get this one
   * running. Shown when discovery finds nothing. */
  hint: string;
}

/** Probed in this order, and the earliest one that answers wins. Ollama leads
 * because it is the most common install and the only one of the three that
 * serves without a GUI step. */
export const LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
  {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    hint: "Install Ollama from ollama.com, then run `ollama pull qwen2.5-coder` - it serves on 11434 by itself.",
  },
  {
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234",
    hint: "In LM Studio, load a model and switch on the local server under Developer - it listens on 1234.",
  },
  {
    label: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080",
    hint: "From a llama.cpp build, run `llama-server -m <model>.gguf --port 8080`.",
  },
];

export interface DiscoveredEndpoint {
  baseUrl: string;
  label: string;
  /** Model ids the server reported, in its own order. Never empty - an
   * endpoint that answers with no models is not a usable discovery. */
  models: string[];
}

export interface ListModelsOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Sent as a bearer token. A local server needs none; a hosted BYOK origin
   * answers 401 without one, which is indistinguishable here from "nothing
   * running" - so a caller that has a key must pass it. */
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Resolves the model ids a server lists, or an empty array for anything that is
 * not a reachable OpenAI-compatible endpoint. Never rejects.
 *
 * Takes an arbitrary origin, not just a `LOCAL_ENDPOINTS` entry, so a caller
 * can ask the same question of a URL the user configured by hand. That does not
 * make this a way to *default* a platform URL - see the RULE 0 note above.
 */
export async function listModels(
  baseUrl: string,
  options: ListModelsOptions = {}
): Promise<string[]> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return [];
  const origin = baseUrl.trim().replace(/\/+$/, "");
  if (origin === "") return [];

  const { signal } = options;
  // An already-aborted signal never fires its event, so the listener below
  // would miss it and the probe would run anyway.
  if (signal?.aborted) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const key = options.apiKey?.trim();
    const response = await doFetch(`${origin}/v1/models`, {
      signal: controller.signal,
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: unknown };
    const entries = body?.data;
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry: unknown) => (entry as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    // Unreachable, timed out, aborted, or answering with something that is not
    // JSON - all of them mean the same thing to a caller: not this one.
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Probes every well-known local endpoint concurrently and returns the first one
 * in `LOCAL_ENDPOINTS` order that answers with at least one model, or null when
 * none does. Never throws.
 *
 * Ordering is by list position, not by who replies fastest: a user with both
 * Ollama and LM Studio open must get the same answer on every launch, and a
 * race would hand them a different model depending on load.
 */
export async function discoverLocalEndpoint(
  fetchImpl?: typeof fetch,
  signal?: AbortSignal
): Promise<DiscoveredEndpoint | null> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;

  const inFlight = LOCAL_ENDPOINTS.map((endpoint) =>
    listModels(endpoint.baseUrl, { fetchImpl: doFetch, signal })
  );
  for (let index = 0; index < inFlight.length; index += 1) {
    const models = await inFlight[index];
    if (models.length === 0) continue;
    const endpoint = LOCAL_ENDPOINTS[index];
    return { baseUrl: endpoint.baseUrl, label: endpoint.label, models };
  }
  return null;
}

export interface ToolCapableModel {
  /** Matched as a substring of a normalised model id. */
  id: string;
  note: string;
}

/** Small models that have been seen to emit usable OpenAI-style tool calls.
 * Curated by hand and deliberately short - see `isLikelyToolCapable` for what
 * this list does and does not claim. */
export const TOOL_CAPABLE_MODELS: readonly ToolCapableModel[] = [
  {
    id: "qwen2.5-coder",
    note: "Trained for code and tool use; the most reliable of these at 7B and the default worth pulling.",
  },
  {
    id: "llama3.1",
    note: "Meta's first Llama generation with tool calling in the chat template; solid but more verbose in its prose.",
  },
  {
    id: "mistral-nemo",
    note: "12B with native function calling; needs more VRAM than a 7B but handles longer tool transcripts.",
  },
  {
    id: "devstral",
    note: "Mistral's agent-tuned coding model, built for exactly this read-edit-run loop.",
  },
];

/** Separators and quantisation suffixes vary by packager: `qwen2.5-coder:7b`
 * (Ollama), `Qwen2.5-Coder-7B-Instruct-GGUF` (LM Studio / Hugging Face) and
 * `qwen2_5_coder` all name the same weights. */
function normalise(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A GUESS, based on the model's NAME only. There is no capability probe here:
 * nothing in this file asks a server whether a model can call tools, and a
 * model id is not a contract - a fine-tune can keep a known name and lose the
 * tool-calling chat template, and plenty of capable models are not on the list.
 *
 * So callers must present this as a suggestion ("known to work well here"),
 * never as fact ("this model supports tools"), and must not use a false result
 * to block a model the user chose. The real answer only arrives when a
 * tool-calling request comes back as `no-tool-support`.
 */
export function isLikelyToolCapable(modelId: string): boolean {
  const haystack = normalise(modelId);
  if (haystack === "") return false;
  return TOOL_CAPABLE_MODELS.some((model) => haystack.includes(normalise(model.id)));
}

/**
 * Picks which of a server's models the agent should ask for: the first one the
 * name heuristic likes, else null for "no opinion - let the server's own first
 * entry stand".
 *
 * This only ever PREFERS. It never removes a model from play, because
 * `isLikelyToolCapable` returning false is an absence of knowledge, not a
 * finding (see its doc comment) - a user who pulled a tool-calling fine-tune we
 * have never heard of still gets it when it is all that is installed.
 */
export function preferToolCapableModel(models: readonly string[]): string | null {
  return models.find((id) => isLikelyToolCapable(id)) ?? null;
}

/** The curated note for a model id, or null when it is not one we have an
 * opinion about. Same heuristic and same caveats as `isLikelyToolCapable`. */
export function toolCapabilityNote(modelId: string): string | null {
  const haystack = normalise(modelId);
  if (haystack === "") return null;
  const match = TOOL_CAPABLE_MODELS.find((model) => haystack.includes(normalise(model.id)));
  return match?.note ?? null;
}
