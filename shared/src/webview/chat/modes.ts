// Pure (DOM-free) rules for the chat app's modes: where a turn is routed,
// Private Mode's outbound guard, when Second Opinion / Ask the team / "Run a
// workflow with this" are offered, Rubber Duck's instructions, and how team
// knowledge hits are folded into a prompt. main.ts calls these; the tests
// pin them.
//
// PRIVATE MODE (the same semantics in every host and every doc): while it is
// on, NO prompt, code, attachment, page text or search query leaves the
// machine. Allowed: the person's own local model server, WebLLM on-device
// inference, and - only on an explicit click - fetching the public model
// manifest and downloading model weights (they carry none of the person's
// content). Blocked: hosted chat, hosted completions, hosted commands,
// knowledge search, the code sandbox (sdlc.run is hosted), workflow runs and
// code validation.

import type { EnginePlatform, KnowledgeHit, WebviewToHost, WebviewTransport } from "../protocol";
import { fenceFor } from "./commands";

// --- routing ---------------------------------------------------------------------

export interface RouteInput {
  privateMode: boolean;
  signedIn: boolean;
  engineReady: boolean;
  /** The person chose "On-device" with the Hosted/On-device switch. */
  localMode: boolean;
}

/** "local" = the on-device engine answers; "hosted" = the selected agent;
 * "private-no-engine" = Private Mode is on and nothing local is ready (the UI
 * says so and offers the model panel - it NEVER falls back to hosted);
 * "none" = signed out with no engine. */
export type Route = "local" | "hosted" | "private-no-engine" | "none";

export function routeFor(input: RouteInput): Route {
  if (input.privateMode) return input.engineReady ? "local" : "private-no-engine";
  if (!input.engineReady) return input.signedIn ? "hosted" : "none";
  if (!input.signedIn) return "local";
  return input.localMode ? "local" : "hosted";
}

/** Message types that carry the person's content off the machine (to the
 * VegaDūta API, via the host). Private Mode never posts them. */
// --- always listening --------------------------------------------------------------

/** Can a held message be sent now? Hosted also needs an agent to address. */
export function canReleaseParked(route: Route, hasAgent: boolean, busy: boolean): boolean {
  if (busy) return false;
  return route === "local" || (route === "hosted" && hasAgent);
}

/** The model a one-click "use on-device AI" should use: one already
 * downloaded first (no wait at all), otherwise the LIGHTEST model the device
 * can run - the fastest download and the least that can go wrong for someone
 * trying it for the first time. Bigger models stay one click away in the
 * list. Never a model that does not fit. */
export function pickQuickModel<M extends { downloaded: boolean; fits: boolean; sizeBytes: number }>(
  models: readonly M[]
): M | undefined {
  const downloaded = models.find((m) => m.downloaded && m.fits);
  if (downloaded) return downloaded;
  return [...models].filter((m) => m.fits).sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
}

/** "Llama-3.2-1B-Instruct-q4f16_1-MLC" -> "Llama 3.2 1B": a name a person
 * can read, for buttons and cards. */
export function friendlyModelName(id: string): string {
  return id
    .replace(/-q\d+f\d+(_\d+)?-MLC$/i, "")
    .replace(/-MLC$/i, "")
    .replace(/-(Instruct|it|Chat)$/i, "")
    .replace(/-/g, " ")
    .replace(/\bit\b/g, "")
    .trim();
}

export const PRIVATE_BLOCKED_TYPES: ReadonlySet<WebviewToHost["type"]> = new Set<WebviewToHost["type"]>([
  "chat.send",
  "knowledge.search",
  "workflow.run",
  "sdlc.run",
]);

/** Wraps the host transport so that, while `isPrivate()` is true, the message
 * types above are DROPPED here - the last line of defence under every UI
 * gate. `onBlocked` lets the UI say what was stopped. */
export function createPrivacyGuard(
  inner: WebviewTransport,
  isPrivate: () => boolean,
  onBlocked?: (message: WebviewToHost) => void
): WebviewTransport {
  return {
    post(message: WebviewToHost): void {
      if (isPrivate() && PRIVATE_BLOCKED_TYPES.has(message.type)) {
        try {
          onBlocked?.(message);
        } catch {
          // Reporting is best-effort; the block itself already happened.
        }
        return;
      }
      inner.post(message);
    },
    onMessage(handler) {
      inner.onMessage(handler);
    },
  };
}

export function hostDisplayName(platform: EnginePlatform): string {
  switch (platform) {
    case "vscode":
      return "VS Code";
    case "chrome":
      return "the Chrome extension";
    case "jetbrains":
      return "the JetBrains IDE";
    case "eclipse":
      return "Eclipse";
    default:
      return "the host";
  }
}

/** The badge under the Private Mode banner. */
export function privacyEnforcementLabel(enforcedByHost: boolean, platform: EnginePlatform): string {
  return enforcedByHost ? `Enforced by ${hostDisplayName(platform)}` : "Enforced in this panel";
}

export const PRIVATE_MODE_SUMMARY =
  "Private Mode: no prompt, code, attachment, page text or search query leaves this machine. " +
  "Allowed: your own local model server, on-device inference, and model downloads you click. " +
  "Blocked: hosted chat, hosted completions and commands, team knowledge search, the code sandbox, " +
  "workflow runs and code validation.";

// --- feature gates ------------------------------------------------------------------

export interface GateInput {
  signedIn: boolean;
  privateMode: boolean;
  engineReady: boolean;
  /** A hosted agent is selected. */
  hasAgent: boolean;
  /** The engine host exists in this page (not just a status). */
  hasEngineHost: boolean;
}

/** Second Opinion needs both sides: a hosted agent (signed in, not private)
 * and a ready on-device engine. */
export function secondOpinionAvailable(g: GateInput): boolean {
  return g.signedIn && !g.privateMode && g.engineReady && g.hasEngineHost && g.hasAgent;
}

export function knowledgeAvailable(g: {
  capabilityKnowledge: boolean;
  signedIn: boolean;
  authMode?: "jwt" | "apiKey" | null;
  privateMode: boolean;
}): boolean {
  return g.capabilityKnowledge && g.signedIn && g.authMode !== "apiKey" && !g.privateMode;
}

export function workflowRunAvailable(g: { signedIn: boolean; privateMode: boolean; workflowCount: number }): boolean {
  return g.signedIn && !g.privateMode && g.workflowCount > 0;
}

// --- rubber duck ----------------------------------------------------------------------

export const DUCK_INSTRUCTION =
  "Rubber duck mode. Help me find the answer myself: ask me ONE short clarifying or guiding question at a time " +
  "about my problem, my assumptions or what I have already tried - then stop and wait for my reply. " +
  "Do not give the solution, code or a list of fixes unless I explicitly ask for the answer (for example \"just tell me\"). " +
  "If I seem close, say so and ask the one question that gets me there.";

export const DUCK_ANSWER_INSTRUCTION =
  "I have asked for the answer now. Give it directly and completely, based on everything we have discussed.";

const JUST_TELL_ME = /\b(just tell me|tell me the answer|give me the answer|what(?:'s| is) the answer|just give me|show me the (?:answer|solution|fix))\b/i;

export function wantsTheAnswer(text: string): boolean {
  return JUST_TELL_ME.test(text);
}

/** The text sent for one Rubber Duck turn. Hosted agents have their own
 * system prompt, so the rule travels with every message. */
export function duckMessage(text: string, answerNow = wantsTheAnswer(text)): string {
  return `[${answerNow ? DUCK_ANSWER_INSTRUCTION : DUCK_INSTRUCTION}]\n\n${text}`;
}

// --- team knowledge -----------------------------------------------------------------

export const KNOWLEDGE_SNIPPET_CHARS = 1600;

/** Plain-language closeness from a vector distance (smaller = closer). The
 * exact metric is the server's; bands are deliberately coarse. */
export function closenessLabel(distance: number | null): string {
  if (distance === null || !Number.isFinite(distance)) return "match";
  if (distance <= 0.25) return "very close";
  if (distance <= 0.45) return "close";
  if (distance <= 0.65) return "related";
  return "loose";
}

export function hitSource(hit: KnowledgeHit, index: number): string {
  const s = (hit.source ?? "").trim();
  return s ? s.slice(0, 160) : `Document ${hit.documentId ?? index + 1}`;
}

/** The instruction for an Ask-the-team answer: the question plus numbered,
 * fenced sources (a fence longer than anything inside, so a snippet cannot
 * close its block), and the rule to cite them as [1], [2]. */
export function buildAskTeamPrompt(question: string, hits: KnowledgeHit[]): string {
  const q = question.trim();
  if (hits.length === 0) return q;
  const parts: string[] = [
    "Answer my question using the numbered sources from my team's knowledge base below. " +
      "Cite the sources you rely on inline as [1], [2]. If the sources do not contain the answer, say so plainly " +
      "instead of guessing, and say what is missing.",
    "",
    `Question: ${q}`,
    "",
    "--- Team knowledge sources ---",
  ];
  hits.forEach((hit, i) => {
    const body = hit.content.length > KNOWLEDGE_SNIPPET_CHARS ? `${hit.content.slice(0, KNOWLEDGE_SNIPPET_CHARS)} …` : hit.content;
    const fence = fenceFor(body);
    parts.push("", `[${i + 1}] ${hitSource(hit, i)}`, fence, body.replace(/\n+$/, ""), fence);
  });
  parts.push("", "--- End of sources ---");
  return parts.join("\n");
}

/** Validates one hit from knowledge.result (host data, still checked). */
export function isKnowledgeHit(v: unknown): v is KnowledgeHit {
  if (!v || typeof v !== "object") return false;
  const h = v as Partial<KnowledgeHit>;
  return (
    typeof h.id === "string" &&
    typeof h.content === "string" &&
    (h.source === null || h.source === undefined || typeof h.source === "string") &&
    (h.distance === null || h.distance === undefined || typeof h.distance === "number")
  );
}

export function describeKnowledgeFailure(reason: string | undefined): string {
  switch (reason) {
    case "signed-out":
      return "Sign in to search your team's knowledge.";
    case "forbidden":
      return "Your account does not have access to the knowledge base. Ask a workspace admin.";
    case "unavailable":
      return "The knowledge base is not available right now. Try again in a moment.";
    case "private":
      return "Team knowledge search is off while Private Mode is on.";
    default:
      return reason ? `The search failed: ${reason.slice(0, 200)}` : "The search failed.";
  }
}

// --- machine check ------------------------------------------------------------------

export function describeBenchmarkFailure(reason: string | undefined): string {
  switch (reason) {
    case "no-engine":
      return "No on-device model is ready to measure. Download one below, or start your local model server, then check again.";
    case "generation-failed":
      return "The test generation failed. The model may not fit this machine's memory - try a smaller one.";
    case "aborted":
      return "The check was stopped before it finished.";
    case "not-implemented":
      return "Machine Check is not available in this build yet.";
    default:
      return reason ? `The check could not run: ${reason.slice(0, 200)}` : "The check could not run.";
  }
}
