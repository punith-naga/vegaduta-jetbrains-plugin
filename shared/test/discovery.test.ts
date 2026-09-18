// Discovery has one job that can go wrong quietly: picking the wrong local
// server, or crashing a client's startup path because nothing is running. Both
// are covered here with an injected fetch - no port is ever opened by this
// file, and no test depends on what happens to be installed on the machine.

import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_ENDPOINTS,
  TOOL_CAPABLE_MODELS,
  discoverLocalEndpoint,
  isLikelyToolCapable,
  listModels,
  preferToolCapableModel,
  toolCapabilityNote,
} from "../src/agent/discovery";

const OLLAMA = "http://127.0.0.1:11434";
const LM_STUDIO = "http://127.0.0.1:1234";
const LLAMA_CPP = "http://127.0.0.1:8080";

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Fake fetch driven by a per-origin script. An origin with no entry behaves
 * like a closed port: the request rejects, exactly as undici does. */
function fakeFetch(script: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const origin = Object.keys(script).find((key) => url.startsWith(key));
    if (!origin) throw new TypeError("fetch failed: ECONNREFUSED");
    return script[origin]();
  }) as unknown as typeof fetch;
}

describe("LOCAL_ENDPOINTS", () => {
  it("probes the three well-known local ports, Ollama first", () => {
    expect(LOCAL_ENDPOINTS.map((endpoint) => endpoint.baseUrl)).toEqual([
      OLLAMA,
      LM_STUDIO,
      LLAMA_CPP,
    ]);
  });

  it("carries a hint for every endpoint, so 'nothing found' is never a dead end", () => {
    for (const endpoint of LOCAL_ENDPOINTS) {
      expect(endpoint.label.length).toBeGreaterThan(0);
      expect(endpoint.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("discoverLocalEndpoint", () => {
  it("prefers the earlier endpoint when several answer", async () => {
    const fetchImpl = fakeFetch({
      [OLLAMA]: () => modelsResponse(["qwen2.5-coder:7b"]),
      [LM_STUDIO]: () => modelsResponse(["some-other-model"]),
      [LLAMA_CPP]: () => modelsResponse(["a-third"]),
    });

    const found = await discoverLocalEndpoint(fetchImpl);

    expect(found).toEqual({
      baseUrl: OLLAMA,
      label: "Ollama",
      models: ["qwen2.5-coder:7b"],
    });
  });

  it("falls through to a later endpoint when the earlier ones are closed", async () => {
    const fetchImpl = fakeFetch({ [LLAMA_CPP]: () => modelsResponse(["local-gguf"]) });

    const found = await discoverLocalEndpoint(fetchImpl);

    expect(found).toMatchObject({ baseUrl: LLAMA_CPP, label: "llama.cpp" });
  });

  it("returns null when nothing is running", async () => {
    const fetchImpl = fakeFetch({});

    await expect(discoverLocalEndpoint(fetchImpl)).resolves.toBeNull();
  });

  it("skips a server that answers but lists no models", async () => {
    // LM Studio with the server on and no model loaded does exactly this, and
    // adopting it would hand the user an endpoint that fails on first use.
    const fetchImpl = fakeFetch({
      [LM_STUDIO]: () => modelsResponse([]),
      [LLAMA_CPP]: () => modelsResponse(["local-gguf"]),
    });

    const found = await discoverLocalEndpoint(fetchImpl);

    expect(found).toMatchObject({ baseUrl: LLAMA_CPP });
  });

  it("returns null when the only server running lists no models", async () => {
    const fetchImpl = fakeFetch({ [OLLAMA]: () => modelsResponse([]) });

    await expect(discoverLocalEndpoint(fetchImpl)).resolves.toBeNull();
  });

  it("never lets a thrown fetch escape to the caller", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await expect(discoverLocalEndpoint(fetchImpl)).resolves.toBeNull();
  });

  it("survives a throwing endpoint and still finds a later one", async () => {
    const fetchImpl = fakeFetch({
      [OLLAMA]: () => {
        throw new Error("connection reset mid-response");
      },
      [LM_STUDIO]: () => modelsResponse(["loaded-model"]),
    });

    await expect(discoverLocalEndpoint(fetchImpl)).resolves.toMatchObject({ baseUrl: LM_STUDIO });
  });

  it("ignores a non-OK status and a body that is not the expected shape", async () => {
    const fetchImpl = fakeFetch({
      [OLLAMA]: () => new Response("nope", { status: 500 }),
      [LM_STUDIO]: () => new Response("<html>not json</html>", { status: 200 }),
      [LLAMA_CPP]: () => new Response(JSON.stringify({ data: "not-an-array" }), { status: 200 }),
    });

    await expect(discoverLocalEndpoint(fetchImpl)).resolves.toBeNull();
  });

  it("drops entries with no usable id rather than returning a blank model", async () => {
    const fetchImpl = fakeFetch({
      [OLLAMA]: () =>
        new Response(JSON.stringify({ data: [{ id: "" }, { name: "no-id" }, null] }), {
          status: 200,
        }),
      [LM_STUDIO]: () => modelsResponse(["real"]),
    });

    await expect(discoverLocalEndpoint(fetchImpl)).resolves.toMatchObject({
      baseUrl: LM_STUDIO,
      models: ["real"],
    });
  });

  it("returns null instead of throwing when the caller already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = fakeFetch({ [OLLAMA]: () => modelsResponse(["m"]) });

    await expect(discoverLocalEndpoint(fetchImpl, controller.signal)).resolves.toBeNull();
  });
});

describe("isLikelyToolCapable", () => {
  it("matches the curated ids across the packagers' naming styles", () => {
    expect(isLikelyToolCapable("qwen2.5-coder:7b")).toBe(true);
    expect(isLikelyToolCapable("Qwen2.5-Coder-7B-Instruct-GGUF")).toBe(true);
    expect(isLikelyToolCapable("llama3.1:8b-instruct-q4_K_M")).toBe(true);
    expect(isLikelyToolCapable("Meta-Llama-3.1-8B-Instruct")).toBe(true);
    expect(isLikelyToolCapable("mistral-nemo:12b")).toBe(true);
    expect(isLikelyToolCapable("devstral:24b")).toBe(true);
  });

  it("stays conservative on names it has no opinion about", () => {
    expect(isLikelyToolCapable("")).toBe(false);
    expect(isLikelyToolCapable("gemma:2b")).toBe(false);
    expect(isLikelyToolCapable("llama2:7b")).toBe(false);
    expect(isLikelyToolCapable("phi3:mini")).toBe(false);
  });

  it("hands back the curated note only for a model it recognises", () => {
    expect(toolCapabilityNote("devstral:24b")).toBe(TOOL_CAPABLE_MODELS[3].note);
    expect(toolCapabilityNote("gemma:2b")).toBeNull();
  });
});

describe("listModels", () => {
  it("reads the ids from an arbitrary origin and tolerates a trailing slash", async () => {
    const fetchImpl = fakeFetch({ [OLLAMA]: () => modelsResponse(["a", "b"]) });

    await expect(listModels(`${OLLAMA}/`, { fetchImpl })).resolves.toEqual(["a", "b"]);
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe(
      `${OLLAMA}/v1/models`
    );
  });

  it("sends the key only when there is one, because a local server has none", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      return modelsResponse(["m"]);
    }) as unknown as typeof fetch;

    await listModels("https://api.example.com/openai", { fetchImpl });
    await listModels("https://api.example.com/openai", { fetchImpl, apiKey: " k " });

    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual({ authorization: "Bearer k" });
  });

  it("answers with an empty list instead of throwing for an unreachable origin", async () => {
    await expect(listModels(OLLAMA, { fetchImpl: fakeFetch({}) })).resolves.toEqual([]);
    await expect(listModels("", { fetchImpl: fakeFetch({}) })).resolves.toEqual([]);
  });
});

describe("preferToolCapableModel", () => {
  it("reaches past an unrecognised first model for one the heuristic likes", () => {
    expect(preferToolCapableModel(["gemma:2b", "llama3.1:8b", "devstral:24b"])).toBe("llama3.1:8b");
  });

  it("has no opinion when nothing on the list is recognised, rather than excluding them", () => {
    // The caller falls back to the server's own first model: a false from the
    // name heuristic is not evidence that a model cannot call tools.
    expect(preferToolCapableModel(["gemma:2b", "phi3:mini"])).toBeNull();
    expect(preferToolCapableModel([])).toBeNull();
  });
});
