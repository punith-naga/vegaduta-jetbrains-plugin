// Framework-free chat webview shared byte-identical by every host: VS Code
// webview, Chrome side panel, JetBrains JCEF and Eclipse SWT Browser. Speaks
// only protocol.ts; transport injected by the host page (VS Code / JCEF
// auto-detected, Chrome passes its loopback half via bootChatApp).
//
// DOM CONTRACT: index.html (and Chrome's own copy of it, which this
// workstream does not own) provides only #auth-bar, .toolbar with
// #agent-select / #workflow-select / #engine-chip, #messages, and a .composer
// footer with #composer-input, #composer-send and optionally #composer-run.
// Everything else - the branded header, welcome screen, history panel,
// context chips, slash-command popup, message toolbars - is CREATED here at
// boot, so both copies of the page keep working.
//
// SECURITY: model and user text only ever reaches the DOM through
// textContent / createTextNode (see markdown.ts for the renderer's rules).
// Links open via ui.openExternal and only for http(s).
//
// Besides hosted chat this page runs:
//   - the on-device engine host (dynamic import, only when the host says
//     hostLocalEngine) with a model panel - Download / Use / Delete;
//   - an "On-device" chat mode: when a local engine is ready the composer
//     works WITHOUT sign-in and every turn runs on the person's machine;
//   - wave 2 (2026-09-18): a role-ordered Toolkit of SDLC recipes (built-in
//     and the person's own, with strict JSON import), Private Mode (see
//     modes.ts for the exact semantics - enforced here by a transport guard
//     under every UI gate), Second Opinion, Rubber Duck, Code Tour, Ask the
//     team, "Run a workflow with this", Machine Check and commit style.

import type { AgentSummary, WorkflowRun, WorkflowSummary } from "../../api/types";
import { TERMINAL_RUN_STATUSES } from "../../api/types";
import { toSandboxLanguage } from "../../api/sdlc";
import { detectTransport } from "../bridge";
import type {
  AuthState,
  ContextItem,
  ContextKind,
  EnginePlatform,
  EngineStatus,
  HostCapabilities,
  HostToWebview,
  WebviewTransport,
} from "../protocol";
import { nextReqId } from "../protocol";
import type { BenchmarkResult, EngineHost } from "../engineHost";
import type { WebLlmModelInfo, WebLlmModelList } from "../../edge/webllmEngine";
import { BRAND_MARK_DATA_URI, BRAND_MARK_HEIGHT, BRAND_MARK_WIDTH } from "./brandMark";
import { createMarkdownView, type MdDocument, type MdElement } from "./markdown";
import {
  ALL_CONTEXT_KINDS,
  availableCommands,
  BUILT_IN_COMMAND_NAMES,
  buildPrompt,
  commandInstruction,
  commitInstruction,
  CONTEXT_KIND_LABELS,
  extractCommitMessage,
  fenceLangToLanguageId,
  fitContextForLocal,
  matchCommands,
  normalizeCapabilities,
  parseSlash,
  requestableContext,
  supportedContext,
  titleFrom,
  type SlashCommand,
} from "./commands";
import { firstCodeBlock } from "./markdown";
import { HistoryStore, safeLocalStorage, type KeyValueStorage, type StoredMessage, type Thread } from "./history";
import { BUILT_IN_RECIPES } from "./recipes/library";
import { findInstantTool, INSTANT_CATEGORY_LABELS, INSTANT_TOOLS, type InstantCategory, type InstantTool } from "./instantTools";
import type { Recipe, RecipeOutput, Role, SdlcPhase } from "./recipes/types";
import {
  exportRecipes,
  FEATURE_CARDS,
  fillRecipePrompt,
  groupRecipes,
  loadPrefs,
  newRecipeId,
  parseRecipeImport,
  PHASES,
  phaseLabel,
  recipeAvailable,
  recipeContextKinds,
  recipeSlashCommands,
  recipeTakesInput,
  roleLabel,
  ROLES,
  savePrefs,
  slashAliasProblem,
  UserRecipeStore,
  validateRecipe,
  type FeatureCard,
} from "./toolkit";
import {
  buildAskTeamPrompt,
  closenessLabel,
  createPrivacyGuard,
  describeBenchmarkFailure,
  describeKnowledgeFailure,
  DUCK_ANSWER_INSTRUCTION,
  DUCK_INSTRUCTION,
  duckMessage,
  hitSource,
  isKnowledgeHit,
  knowledgeAvailable,
  PRIVATE_MODE_SUMMARY,
  privacyEnforcementLabel,
  routeFor,
  canReleaseParked,
  pickQuickModel,
  secondOpinionAvailable,
  wantsTheAnswer,
  workflowRunAvailable,
  type Route,
} from "./modes";
import { countLines, formatStopRange, numberLines, parseTourStops, TOUR_INSTRUCTION, tourProse, type TourStop } from "./tour";
import type { KnowledgeHit } from "../protocol";

interface ChatAppState {
  auth: AuthState;
  agents: AgentSummary[];
  workflows: WorkflowSummary[];
  selectedAgentId: string | null;
  streamingReqId: string | null;
  engine: EngineStatus;
  hostLocalEngine: boolean;
  apiBase: string;
  platform: EnginePlatform;
  capabilities: HostCapabilities;
  /** True = the composer routes to the on-device engine instead of the
   * hosted agent. Forced on while signed out (nothing else could answer). */
  localMode: boolean;
  /** Set once the person has flipped the toggle themselves; until then the
   * mode follows "signed out -> local, signed in -> hosted". */
  localModeChosen: boolean;
  models: WebLlmModelList | null;
  modelsOpen: boolean;
  /** Model id currently downloading, for the row's progress bar. */
  downloadingId: string | null;
  /** Context chips attached to the next message. */
  attached: ContextItem[];
  /** A send waiting for its context to arrive. */
  gathering: boolean;
  historyOpen: boolean;
  // --- wave 2 ---
  /** Private Mode (persisted). See modes.ts for exactly what it blocks. */
  privateMode: boolean;
  /** The host confirmed it enforces Private Mode on its own paths too. */
  privacyEnforced: boolean;
  /** The person's role (persisted); null = not chosen, treated as developer. */
  role: Role | null;
  /** The first-run role step has been answered or skipped. */
  onboarded: boolean;
  /** Rubber Duck mode: the assistant asks, one question at a time. */
  duck: boolean;
  /** Second Opinion for every send while on (composer option). */
  compareNext: boolean;
  toolkitOpen: boolean;
  toolkitView: "list" | "edit" | "import";
  /** Recipe being edited (null = a new one). */
  editingRecipeId: string | null;
  toolkitQuery: string;
  /** Recipe picked from the Toolkit, waiting for the person's input. */
  armedRecipe: Recipe | null;
  bench: { running: boolean; result: BenchmarkResult | null };
  /** Always listening: a message sent before anything could answer (signed
   * out, no model yet). Held - never dropped - and sent by itself the moment
   * sign-in completes or an on-device model is ready. */
  parked: SendRequest | null;
  /** Instant Tools drawer (offline utilities - no account, model or network). */
  toolsOpen: boolean;
  toolId: string | null;
  toolsQuery: string;
  /** The person is typing right now (drives the header's live indicator). */
  typing: boolean;
}

const state: ChatAppState = {
  auth: { signedIn: false },
  agents: [],
  workflows: [],
  selectedAgentId: null,
  streamingReqId: null,
  engine: { state: "unavailable" },
  hostLocalEngine: false,
  apiBase: "",
  platform: "chrome",
  capabilities: normalizeCapabilities(undefined),
  localMode: false,
  localModeChosen: false,
  models: null,
  modelsOpen: false,
  downloadingId: null,
  attached: [],
  gathering: false,
  historyOpen: false,
  privateMode: false,
  privacyEnforced: false,
  role: null,
  onboarded: false,
  duck: false,
  compareNext: false,
  toolkitOpen: false,
  toolkitView: "list",
  editingRecipeId: null,
  toolkitQuery: "",
  armedRecipe: null,
  bench: { running: false, result: null },
  parked: null,
  toolsOpen: false,
  toolId: null,
  toolsQuery: "",
  typing: false,
};

let transport: WebviewTransport;
let history: HistoryStore;
let thread: Thread | null = null;
let prefsStorage: KeyValueStorage | null = null;
let userRecipes: UserRecipeStore;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function composerInput(): HTMLTextAreaElement {
  return $("composer-input") as HTMLTextAreaElement;
}

// --- icons (static, author-controlled path data only) ------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS: Record<string, string[]> = {
  plus: ["M12 5v14", "M5 12h14"],
  history: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"],
  help: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3", "M12 17h.01"],
  close: ["M18 6 6 18", "M6 6l12 12"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  retry: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
  clip: ["M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  shield: ["M12 3l8 3v6c0 5-3.5 8.3-8 9-4.5-.7-8-4-8-9V6z"],
  shieldOn: ["M12 3l8 3v6c0 5-3.5 8.3-8 9-4.5-.7-8-4-8-9V6z", "M9 12l2 2 4-4"],
  grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  columns: ["M4 5h7v14H4z", "M13 5h7v14h-7z"],
  spark: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"],
  code: ["M8 7l-5 5 5 5", "M16 7l5 5-5 5", "M14 4l-4 16"],
  flask: ["M9 3h6", "M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3", "M7 15h10"],
  eye: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5", "M3 17.5l9 5 9-5"],
  target: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"],
  rocket: ["M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2", "M9 12a15 15 0 0 1 11-9c0 4-2 8.5-9 11z", "M9 12l3 3", "M9 12H5l2-4h4", "M12 15v4l4-2v-4"],
  commit: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M3 12h5", "M16 12h5"],
  wrench: ["M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"],
  globe: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M2 12h20", "M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"],
  map: ["M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z", "M9 4v14", "M15 6v14"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M22 21v-2a4 4 0 0 0-3-3.9", "M16 3.1a4 4 0 0 1 0 7.8"],
  chip: ["M6 6h12v12H6z", "M9 9h6v6H9z", "M9 2v4", "M15 2v4", "M9 18v4", "M15 18v4", "M2 9h4", "M2 15h4", "M18 9h4", "M18 15h4"],
  key: ["M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z", "M16 11h.01"],
  bolt: ["M13 2L4 14h7l-1 8 9-12h-7z"],
  send: ["M5 12h14", "M13 6l6 6-6 6"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  play: ["M7 4v16l13-8z"],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  back: ["M15 18l-6-6 6-6"],
};

function icon(name: keyof typeof ICONS | string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function iconButton(name: string, label: string, onClick: () => void, className = "vd-icon-btn"): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(name));
  b.addEventListener("click", onClick);
  return b;
}

/** Brief "Copied" style feedback on a button, restoring its label after. */
function flash(b: HTMLButtonElement, text: string): void {
  const original = b.dataset.label ?? b.textContent ?? "";
  b.dataset.label = original;
  b.textContent = text;
  window.setTimeout(() => {
    b.textContent = original;
  }, 1400);
}

function brandMark(heightPx: number, className: string): HTMLImageElement {
  const img = el("img", className);
  img.src = BRAND_MARK_DATA_URI;
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.draggable = false;
  // Sized by HEIGHT, width follows the emblem's own aspect ratio.
  img.height = heightPx;
  img.width = Math.round((BRAND_MARK_WIDTH / BRAND_MARK_HEIGHT) * heightPx);
  return img;
}

// --- mode helpers --------------------------------------------------------------

function engineReady(): boolean {
  return state.engine.state === "ready";
}

/** Where the next turn goes (modes.ts routeFor - Private Mode never routes
 * hosted, and never falls back to hosted when nothing local is ready). */
function routeNow(): Route {
  return routeFor({
    privateMode: state.privateMode,
    signedIn: state.auth.signedIn,
    engineReady: engineReady(),
    localMode: state.localMode,
  });
}

/** The composer is usable when a hosted agent can answer (signed in) or the
 * on-device engine can (ready) - and, in Private Mode, only the latter. */
function canCompose(): boolean {
  const r = routeNow();
  return r === "local" || r === "hosted";
}

function usingLocal(): boolean {
  return routeNow() === "local";
}

function secondOpinionOk(): boolean {
  return secondOpinionAvailable({
    signedIn: state.auth.signedIn,
    privateMode: state.privateMode,
    engineReady: engineReady(),
    hasAgent: state.selectedAgentId !== null,
    hasEngineHost: engineHost !== null,
  });
}

function knowledgeOk(): boolean {
  return knowledgeAvailable({
    capabilityKnowledge: state.capabilities.knowledge === true,
    signedIn: state.auth.signedIn,
    authMode: state.auth.mode,
    privateMode: state.privateMode,
  });
}

function workflowOk(): boolean {
  return workflowRunAvailable({
    signedIn: state.auth.signedIn,
    privateMode: state.privateMode,
    workflowCount: state.workflows.length,
  });
}

function currentRole(): Role {
  return state.role ?? "developer";
}

function persistPrefs(): void {
  savePrefs(prefsStorage, { role: state.role, onboarded: state.onboarded, privateMode: state.privateMode });
}

function allRecipes(): Recipe[] {
  return [...BUILT_IN_RECIPES, ...(userRecipes?.list() ?? [])];
}

function findRecipe(id: string): Recipe | undefined {
  return BUILT_IN_RECIPES.find((r) => r.id === id) ?? userRecipes?.get(id);
}

function recipeSlash(): ReturnType<typeof recipeSlashCommands> {
  return recipeSlashCommands(allRecipes(), state.capabilities, BUILT_IN_COMMAND_NAMES);
}

function busy(): boolean {
  return state.streamingReqId !== null || state.gathering;
}

function selectedAgentName(): string | null {
  return state.agents.find((a) => a.id === state.selectedAgentId)?.name ?? null;
}

function commandsHere(): SlashCommand[] {
  return [
    ...availableCommands({
      capabilities: state.capabilities,
      hostLocalEngine: state.hostLocalEngine,
      knowledge: knowledgeOk(),
    }),
    ...recipeSlash().commands,
  ];
}

// --- branded header -------------------------------------------------------------

function mountHeader(): void {
  if (document.getElementById("vd-header")) return;
  const header = el("div", "vd-header");
  header.id = "vd-header";
  const brand = el("div", "vd-brand");
  brand.append(brandMark(26, "vd-emblem"), el("span", "vd-wordmark", "VegaDūta"));
  const live = el("span", "vd-live");
  live.id = "vd-live";
  live.setAttribute("role", "status");
  live.append(el("span", "vd-live-dot"), el("span", "vd-live-label"));
  brand.append(live);
  const actions = el("div", "vd-header-actions");
  const shield = iconButton("shield", "Private Mode", () => setPrivateMode(!state.privateMode));
  shield.id = "vd-private-toggle";
  actions.append(
    shield,
    iconButton("bolt", "Instant tools - JSON, JWT, regex, cron and more; offline, no account", () => toggleTools()),
    iconButton("grid", "Toolkit - recipes for every SDLC phase", () => toggleToolkit()),
    iconButton("plus", "New chat", () => newChat()),
    iconButton("history", "Conversation history", () => toggleHistory()),
    iconButton("help", "Help and commands", () => showHelp())
  );
  header.append(brand, actions);
  document.body.prepend(header);
  renderPrivacy();
}

// --- room: a panel too small to use comfortably -------------------------------------

/** Below these the panel still works, but cramped: say so, and say how to get
 * more room in THIS host. */
const ROOM_MIN_WIDTH = 330;
const ROOM_MIN_HEIGHT = 520;
const ROOM_HINT_DISMISSED_KEY = "vd.roomHint.dismissed";

function roomAdvice(): string {
  switch (state.platform) {
    case "vscode":
      return "Drag the panel's edge to widen it - or drag the VegaDūta icon to the Secondary Side Bar on the right for a roomy panel next to your code.";
    case "chrome":
      return "Drag the side panel's left edge to widen it.";
    case "jetbrains":
      return "Drag the tool window's edge to resize it, or open VegaDūta in its own window.";
    case "eclipse":
      return "Drag the view's edge to resize it, or right-click its tab and choose Detach to give it its own window.";
    default:
      return "Make this panel wider or taller for the best experience.";
  }
}

function roomHintDismissed(): boolean {
  try {
    return prefsStorage?.getItem(ROOM_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function renderRoomHint(): void {
  const cramped = window.innerWidth < ROOM_MIN_WIDTH || window.innerHeight < ROOM_MIN_HEIGHT;
  let bar = document.getElementById("vd-room");
  if (!cramped || roomHintDismissed()) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = el("section", "vd-room");
    bar.id = "vd-room";
    bar.setAttribute("role", "note");
    bar.setAttribute("aria-label", "Panel size");
    const header = document.getElementById("vd-header");
    if (header) header.after(bar);
    else document.body.prepend(bar);
  }
  bar.textContent = "";
  const ic = el("span", "vd-room-icon");
  ic.append(icon("expand"));
  const text = el("span", "vd-room-text");
  text.append(el("strong", undefined, "More room, better experience. "), el("span", undefined, roomAdvice()));
  bar.append(ic, text);
  const actions = el("span", "vd-room-actions");
  if (state.capabilities.popOut) {
    const pop = el("button", "btn-primary vd-room-pop");
    pop.type = "button";
    pop.append(icon("expand"), el("span", undefined, "Open in window"));
    pop.addEventListener("click", () => transport.post({ type: "ui.popOut" }));
    actions.append(pop);
  }
  actions.append(
    iconButton("close", "Don't show this again", () => {
      try {
        prefsStorage?.setItem(ROOM_HINT_DISMISSED_KEY, "1");
      } catch {
        // Storage unavailable: hide it for this session only.
      }
      bar?.remove();
    })
  );
  bar.append(actions);
}

/** Re-check on every resize (throttled to a frame): the hint appears when the
 * panel gets cramped and disappears as soon as it has room. */
function watchRoom(): void {
  let queued = false;
  window.addEventListener("resize", () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      renderRoomHint();
    });
  });
  renderRoomHint();
}

// --- Private Mode -------------------------------------------------------------------

/** The shield's pressed state and the banner under the header. */
function renderPrivacy(): void {
  const toggle = document.getElementById("vd-private-toggle") as HTMLButtonElement | null;
  if (toggle) {
    toggle.replaceChildren(icon(state.privateMode ? "shieldOn" : "shield"));
    toggle.setAttribute("aria-pressed", String(state.privateMode));
    toggle.classList.toggle("vd-icon-btn-on", state.privateMode);
    const label = state.privateMode
      ? "Private Mode is on - click to turn it off"
      : "Private Mode is off - click to keep prompts, code and searches on this machine";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
  }
  let banner = document.getElementById("vd-private-banner");
  if (!state.privateMode) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = el("section", "vd-private-banner");
    banner.id = "vd-private-banner";
    banner.setAttribute("aria-label", "Private Mode");
    banner.setAttribute("role", "status");
    const header = document.getElementById("vd-header");
    if (header) header.after(banner);
    else document.body.prepend(banner);
  }
  banner.textContent = "";
  const top = el("div", "vd-private-top");
  const title = el("strong", "vd-private-title");
  title.append(icon("shieldOn"), el("span", undefined, "Private Mode"));
  top.append(title, el("span", "vd-private-badge", privacyEnforcementLabel(state.privacyEnforced, state.platform)));
  top.append(button("Turn off", "btn-ghost vd-private-off", () => setPrivateMode(false)));
  banner.append(top);
  banner.append(el("p", "vd-private-line", "Prompts, code, attachments, page text and searches stay on this machine."));
  const details = el("details", "vd-private-details");
  details.append(el("summary", undefined, "What is allowed and blocked?"), el("p", undefined, PRIVATE_MODE_SUMMARY));
  if (!state.privacyEnforced) {
    details.append(
      el(
        "p",
        undefined,
        "This panel blocks every hosted request it could make. The host has not confirmed it blocks its own hosted features too (such as hosted inline completions), so check those in its settings."
      )
    );
  }
  banner.append(details);
  if (!engineReady()) {
    const warn = el("div", "vd-private-warn");
    if (state.hostLocalEngine) {
      warn.append(
        el(
          "span",
          undefined,
          state.engine.state === "loading"
            ? "The on-device model is still loading - chat starts when it is ready."
            : "No on-device model is ready, so nothing can answer yet. Nothing is sent to a hosted agent instead."
        ),
        button("Open on-device models", "btn-primary", () => void toggleModels(true))
      );
    } else {
      warn.append(
        el(
          "span",
          undefined,
          "This host has no on-device engine, so nothing can answer in Private Mode. Point VegaDūta at your own local model server in its settings, or turn Private Mode off."
        )
      );
    }
    banner.append(warn);
  }
}

/** Turn Private Mode on or off: persisted, pushed to the engine layer (which
 * then skips code validation) and to the host (which may enforce it on its
 * own hosted paths and answers with privacy.state). */
function setPrivateMode(on: boolean): void {
  if (on === state.privateMode) return;
  if (on && state.streamingReqId && !localReqs.has(state.streamingReqId)) abortCurrent();
  state.privateMode = on;
  state.privacyEnforced = false;
  if (on) {
    state.compareNext = false;
    cancelKnowledgeSearches();
  }
  persistPrefs();
  try {
    engineHost?.setPrivateMode(on);
  } catch {
    // The engine layer's own flag is belt-and-braces; the guard below holds.
  }
  transport.post({ type: "privacy.mode", private: on });
  // Hosted and private conversations never mix.
  if (on && thread && thread.mode === "hosted" && thread.messages.length > 0) newChat();
  if (on) appendSystem("Private Mode is on. Answers now come only from the model on this machine.");
  else appendSystem("Private Mode is off. Hosted agents, team knowledge and workflows are available again.");
  renderPrivacy();
  renderLocalToggle();
  renderAgents();
  renderAuth();
  if (state.toolkitOpen) renderToolkit();
}

// --- auth / toolbar / composer ----------------------------------------------------

function renderAuth(): void {
  const bar = $("auth-bar");
  bar.textContent = "";
  bar.classList.toggle("auth-bar-out", !state.auth.signedIn);
  if (state.auth.signedIn) {
    const name = state.auth.username || "Signed in";
    const avatar = el("span", "auth-avatar", name.trim().charAt(0).toUpperCase() || "V");
    avatar.setAttribute("aria-hidden", "true");
    const text = el("span", "auth-text");
    const who = el("span", "auth-user", name);
    if (state.auth.mode === "apiKey") who.title = "Signed in with an API key - some features are reduced.";
    text.append(who, el("span", "auth-sub", state.privateMode ? "Private Mode - on-device only" : "Team agents, knowledge and workflows"));
    const out = el("button", "btn-ghost auth-btn");
    out.type = "button";
    out.title = "Sign out";
    out.append(icon("logout"), el("span", "auth-btn-label", "Sign out"));
    out.addEventListener("click", () => transport.post({ type: "auth.signOut" }));
    bar.append(avatar, text, out);
  } else {
    const badge = el("span", "auth-avatar auth-avatar-spark");
    badge.append(icon("spark"));
    const text = el("span", "auth-text");
    text.append(
      el("span", "auth-user", "Ready - no account needed"),
      el(
        "span",
        "auth-sub",
        engineReady()
          ? "Chatting on this device. Sign in for team agents."
          : state.hostLocalEngine
            ? "Free on-device AI and tools. Sign in for team agents."
            : "Tools work now. Sign in to chat with your agents."
      )
    );
    const signIn = el("button", "btn-primary auth-btn");
    signIn.type = "button";
    signIn.append(icon("key"), el("span", "auth-btn-label", "Sign in"));
    signIn.addEventListener("click", () => transport.post({ type: "auth.signIn" }));
    bar.append(badge, text, signIn);
  }
  renderComposer();
  renderWelcome();
  releaseParkedSoon();
}

function renderComposer(): void {
  const input = composerInput();
  const send = $("composer-send") as HTMLButtonElement;
  const enabled = canCompose();
  // Always listening: the box never locks. With nothing able to answer yet,
  // a message is held (parkRequest) and sent the moment something can.
  input.disabled = false;
  send.disabled = state.gathering && !state.streamingReqId;
  if (!state.streamingReqId) setSendLabel(send, state.gathering ? "…" : "Send");
  if (!enabled && state.privateMode) {
    input.placeholder = "Ask privately - I'll answer as soon as an on-device model is ready";
  } else if (!enabled) {
    input.placeholder = state.hostLocalEngine
      ? "Ask anything - explain, test, review, refactor… (/ for commands)"
      : "Ask anything - sign in and I'll answer (/ for commands)";
  } else if (state.armedRecipe) {
    input.placeholder = recipeTakesInput(state.armedRecipe)
      ? `${state.armedRecipe.name}: add details, then Enter`
      : `${state.armedRecipe.name}: press Enter to run (a note is optional)`;
  } else if (state.duck) {
    input.placeholder = "Rubber duck: describe the problem - I'll ask questions. Say \"just tell me\" for the answer";
  } else if (usingLocal()) {
    input.placeholder = `Ask ${state.privateMode ? "privately " : ""}on-device${state.engine.modelId ? ` (${shortModelName(state.engine.modelId)})` : ""} - type / for commands`;
  } else {
    const name = selectedAgentName();
    input.placeholder = `Ask ${name ?? "your agent"} - type / for commands`;
  }
  renderContextBar();
  renderHint();
  renderLive();
}

/** The Send button: its label plus an arrow (Send), or just the label. */
function setSendLabel(b: HTMLElement, label: string): void {
  if (b.dataset.vdLabel === label && b.childNodes.length) return;
  b.dataset.vdLabel = label;
  b.textContent = "";
  b.append(el("span", "vd-send-label", label));
  if (label === "Send") b.append(icon("send"));
}

/** Header live indicator: what the assistant is doing right now. */
function renderLive(): void {
  const live = document.getElementById("vd-live");
  if (!live) return;
  const [status, label] =
    state.streamingReqId || state.gathering
      ? ["thinking", "Thinking"]
      : state.typing
        ? ["listening", "Listening"]
        : state.engine.state === "loading"
          ? ["loading", `Loading ${Math.round((state.engine.progress ?? 0) * 100)}%`]
          : state.parked
            ? ["waiting", "Holding 1"]
            : canCompose()
              ? ["ready", usingLocal() ? "On-device" : "Ready"]
              : ["listening-idle", "Listening"];
  live.className = `vd-live vd-live-${status}`;
  const text = live.querySelector(".vd-live-label");
  if (text) text.textContent = label;
  live.title =
    status === "listening-idle" || status === "waiting"
      ? "Always listening - type anything. I'll answer the moment you sign in or an on-device model is ready."
      : `VegaDūta: ${label}`;
}

let typingTimer: number | undefined;
function noteTyping(): void {
  state.typing = composerInput().value.length > 0;
  window.clearTimeout(typingTimer);
  if (state.typing) {
    typingTimer = window.setTimeout(() => {
      state.typing = false;
      renderLive();
    }, 1500);
  }
  renderLive();
}

// --- always listening: held messages ---------------------------------------------

/** Nothing can answer yet: keep the message, say so warmly, and offer the
 * one-click ways to get an answer. It sends itself when one is ready. */
function parkRequest(req: SendRequest): void {
  state.parked = req;
  composerInput().value = "";
  autoGrow();
  setNotice(null);
  renderParked();
  renderLive();
  scrollToBottom(true);
}

function renderParked(): void {
  let card = document.getElementById("vd-parked");
  if (!state.parked) {
    card?.remove();
    return;
  }
  document.getElementById("vd-welcome")?.remove();
  if (!card) {
    card = el("section", "vd-parked");
    card.id = "vd-parked";
    card.setAttribute("role", "status");
    messagesEl().append(card);
  }
  card.textContent = "";
  const head = el("div", "vd-parked-head");
  const orb = el("span", "vd-orb");
  orb.append(brandMark(22, "vd-orb-emblem"));
  head.append(orb, el("strong", undefined, "Got it - I'm holding your question"));
  card.append(head, el("blockquote", "vd-parked-quote", state.parked.display));

  const options = el("div", "vd-parked-options");
  if (state.hostLocalEngine) {
    const loading = state.engine.state === "loading" || state.downloadingId !== null;
    options.append(
      optionTile(
        "chip",
        loading ? `Getting the model ready… ${Math.round((state.engine.progress ?? 0) * 100)}%` : "Answer on this device",
        loading ? "I'll reply the moment it finishes" : "Free and private - one download, nothing leaves your machine",
        () => void quickLocalModel(),
        loading
      )
    );
  }
  if (!state.privateMode) {
    options.append(
      optionTile("key", "Sign in to VegaDūta", "Your team's agents, knowledge and workflows", () =>
        transport.post({ type: "auth.signIn" })
      )
    );
  }
  if (!options.childElementCount) {
    options.append(
      el("p", "vd-parked-note", "Private Mode is on and this host has no on-device engine. Turn Private Mode off to use a hosted agent.")
    );
  }
  card.append(options);
  const foot = el("div", "vd-parked-foot");
  foot.append(
    el("span", undefined, "I'll answer automatically as soon as one is ready."),
    button("Edit question", "vd-link-btn", () => {
      const text = state.parked?.display ?? "";
      state.parked = null;
      renderParked();
      renderWelcome();
      const input = composerInput();
      input.value = text;
      autoGrow();
      input.focus();
      renderLive();
    })
  );
  card.append(foot);
}

function optionTile(iconName: string, title: string, detail: string, run: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", "vd-option");
  b.type = "button";
  b.disabled = disabled;
  const ic = el("span", "vd-option-icon");
  ic.append(icon(iconName));
  const text = el("span", "vd-option-text");
  text.append(el("span", "vd-option-title", title), el("span", "vd-option-detail", detail));
  b.append(ic, text);
  b.addEventListener("click", run);
  return b;
}

/** One click to an on-device answer: download the recommended model when the
 * device can run one, otherwise open the model list, which says why not. */
async function quickLocalModel(): Promise<void> {
  if (!engineHost) {
    void toggleModels(true);
    return;
  }
  if (!state.models) state.models = await engineHost.listModels();
  const pick = pickQuickModel(state.models.models);
  if (!state.models.webgpu || !pick || pick.downloaded) {
    void toggleModels(true);
    return;
  }
  const done = startDownload(pick);
  renderParked();
  renderWelcome();
  await done;
  renderParked();
  renderWelcome();
}

let releaseQueued = false;
/** Send the held message once something can answer (hosted also needs an agent). */
function releaseParkedSoon(): void {
  if (!state.parked) return;
  if (releaseQueued) return;
  releaseQueued = true;
  window.setTimeout(() => {
    releaseQueued = false;
    const req = state.parked;
    if (!req) return;
    if (!canReleaseParked(routeNow(), state.selectedAgentId !== null, busy())) {
      renderParked();
      return;
    }
    state.parked = null;
    renderParked();
    send(req);
  }, 0);
}

function renderAgents(): void {
  const select = $("agent-select") as HTMLSelectElement;
  select.textContent = "";
  for (const agent of state.agents) {
    const option = el("option");
    option.value = agent.id;
    option.textContent = agent.name;
    select.append(option);
  }
  if (state.agents.length === 0) {
    const option = el("option", undefined, state.auth.signedIn ? "No agents yet" : "Sign in for agents");
    option.value = "";
    select.append(option);
  }
  if (state.selectedAgentId && state.agents.some((a) => a.id === state.selectedAgentId)) {
    select.value = state.selectedAgentId;
  } else {
    state.selectedAgentId = state.agents[0]?.id ?? null;
  }

  const wfSelect = $("workflow-select") as HTMLSelectElement;
  wfSelect.textContent = "";
  wfSelect.disabled = state.privateMode;
  wfSelect.title = state.privateMode ? "Workflows run on the server - off while Private Mode is on" : "Run a workflow";
  const placeholder = el(
    "option",
    undefined,
    state.privateMode ? "Workflows off (Private Mode)" : state.workflows.length ? "Run a workflow…" : "No workflows"
  );
  placeholder.value = "";
  wfSelect.append(placeholder);
  for (const wf of state.workflows) {
    const option = el("option");
    option.value = wf.id;
    option.textContent = wf.name;
    wfSelect.append(option);
  }
  renderComposer();
  renderWelcome();
  releaseParkedSoon();
}

/** "Llama-3.2-1B-Instruct-q4f16_1-MLC" -> "Llama-3.2-1B-Instruct". */
function shortModelName(id: string): string {
  return id.replace(/-q\d+f\d+(_\d+)?-MLC$/i, "").replace(/-MLC$/i, "");
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "?";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function renderEngine(): void {
  const chip = $("engine-chip");
  chip.className = `engine-chip engine-${state.engine.state}`;
  const label =
    state.engine.state === "ready"
      ? `On-device: ${state.engine.modelId ? shortModelName(state.engine.modelId) : "ready"}${state.engine.backend ? ` (${state.engine.backend})` : ""}`
      : state.engine.state === "loading"
        ? `Loading model… ${Math.round((state.engine.progress ?? 0) * 100)}%`
        : state.engine.state === "idle"
          ? "On-device: download a model"
          : `On-device off${state.engine.detail ? `: ${state.engine.detail}` : ""}`;
  chip.textContent = label;
  if (state.hostLocalEngine) {
    chip.classList.add("engine-chip-clickable");
    chip.title = "On-device models - click to download, switch or delete";
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
  }
  renderLocalToggle();
  renderComposer();
  renderWelcome();
  renderPrivacy();
  if (state.modelsOpen) renderModels();
  releaseParkedSoon();
}

/** The hosted <-> on-device switch. Only shown when both are possible; while
 * signed out the composer is on-device by construction. */
function renderLocalToggle(): void {
  let toggle = document.getElementById("local-toggle") as HTMLButtonElement | null;
  const show = state.auth.signedIn && engineReady() && !state.privateMode;
  if (!show) {
    toggle?.remove();
    return;
  }
  if (!toggle) {
    toggle = el("button", "btn-ghost local-toggle");
    toggle.id = "local-toggle";
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      if (busy()) return;
      state.localMode = !state.localMode;
      state.localModeChosen = true;
      // Hosted and on-device conversations never mix.
      if (thread && thread.messages.length > 0) newChat();
      renderLocalToggle();
      renderComposer();
    });
    $("engine-chip").before(toggle);
  }
  toggle.textContent = state.localMode ? "On-device" : "Hosted";
  toggle.setAttribute("aria-pressed", String(state.localMode));
  toggle.title = state.localMode
    ? "Answers run on this machine. Click to use your hosted agent instead."
    : "Answers come from your hosted agent. Click to run on this machine instead.";
  toggle.classList.toggle("local-toggle-on", state.localMode);
}

// --- on-device model panel -------------------------------------------------------

function modelsPanel(): HTMLElement {
  let panel = document.getElementById("engine-panel");
  if (!panel) {
    panel = el("section", "engine-panel");
    panel.id = "engine-panel";
    panel.setAttribute("aria-label", "On-device models");
    const toolbar = document.querySelector(".toolbar");
    if (toolbar) toolbar.after(panel);
    else document.body.prepend(panel);
  }
  return panel;
}

async function toggleModels(open?: boolean): Promise<void> {
  state.modelsOpen = open ?? !state.modelsOpen;
  if (state.modelsOpen) closeOtherDrawers("models");
  syncDrawerLayout();
  if (!state.modelsOpen) {
    document.getElementById("engine-panel")?.remove();
    return;
  }
  renderModels();
  await refreshModels();
}

async function refreshModels(): Promise<void> {
  if (!engineHost) return;
  state.models = await engineHost.listModels();
  if (state.modelsOpen) renderModels();
}

function renderModels(): void {
  const panel = modelsPanel();
  panel.textContent = "";

  const head = el("div", "engine-panel-head");
  head.append(el("strong", undefined, "On-device models"));
  head.append(button("Close", "btn-ghost", () => void toggleModels(false)));
  panel.append(head);

  if (!engineHost) {
    panel.append(el("p", "engine-panel-note", "The on-device engine is not enabled for this host."));
    return;
  }
  const models = state.models;
  if (!models) {
    panel.append(el("p", "engine-panel-note", "Checking this device…"));
    return;
  }

  if (!models.webgpu) {
    panel.append(
      el(
        "p",
        "engine-panel-note",
        "This host has no WebGPU, so in-browser models cannot run here. " +
          "A local server you run yourself (Ollama, LM Studio, llama.cpp) still works: " +
          (state.engine.state === "ready"
            ? `connected to ${state.engine.backend ?? "it"} now.`
            : state.engine.detail
              ? `currently ${state.engine.detail}.`
              : "start one and reopen this panel.")
      )
    );
  } else {
    panel.append(
      el(
        "p",
        "engine-panel-note",
        "Runs on your GPU, in this window, with nothing sent anywhere. A download happens only when you click it, " +
          "is stored by the browser, and can be deleted here."
      )
    );
  }

  panel.append(renderMachineCheck(models));

  const prefRow = el("label", "engine-pref");
  prefRow.append(el("span", undefined, "Prefer"));
  const pref = el("select");
  const options: Array<[string, string]> = [
    ["auto", "Best fit for this device"],
    ["hosted", "Hosted only (never on-device)"],
  ];
  for (const m of models.models) {
    if (m.downloaded || m.id === models.override) options.push([m.id, shortModelName(m.id)]);
  }
  for (const [value, label] of options) {
    const opt = el("option", undefined, label);
    opt.value = value;
    pref.append(opt);
  }
  pref.value = options.some(([v]) => v === models.override) ? models.override : "auto";
  pref.addEventListener("change", () => {
    void (async () => {
      await engineHost?.setModelOverride(pref.value);
      await refreshModels();
    })();
  });
  prefRow.append(pref);
  panel.append(prefRow);

  const list = el("ul", "engine-models");
  for (const m of models.models) {
    list.append(renderModelRow(m, models.webgpu));
  }
  if (models.models.length === 0) {
    list.append(el("li", "engine-panel-note", "No models are listed for this platform."));
  }
  panel.append(list);
}

function renderModelRow(m: WebLlmModelInfo, webgpu: boolean): HTMLElement {
  const row = el("li", `engine-model${m.downloaded ? " engine-model-downloaded" : ""}`);
  const info = el("div", "engine-model-info");
  info.append(el("div", "engine-model-name", m.displayName || shortModelName(m.id)));
  const metaParts = [formatBytes(m.sizeBytes)];
  if (m.speedTier) metaParts.push(m.speedTier === "fast" ? "fast" : "more capable");
  if (m.contextWindowSize) metaParts.push(`${m.contextWindowSize} ctx`);
  if (m.recommended && !m.downloaded) metaParts.push("recommended");
  if (m.downloaded) metaParts.push("downloaded");
  if (webgpu && !m.fits) metaParts.push("may not fit this device");
  info.append(el("div", "engine-model-meta", metaParts.join(" · ")));
  if (m.detailName) info.append(el("div", "engine-model-detail", m.detailName));
  row.append(info);

  if (state.downloadingId === m.id) {
    const bar = el("div", "engine-progress");
    const fill = el("div", "engine-progress-fill");
    const pct =
      state.engine.state === "loading" && state.engine.modelId === m.id
        ? Math.round((state.engine.progress ?? 0) * 100)
        : 0;
    fill.style.width = `${pct}%`;
    bar.append(fill);
    info.append(bar);
    info.append(el("div", "engine-model-meta", `Downloading… ${pct}%`));
    return row;
  }

  const actions = el("div", "engine-model-actions");
  if (m.downloaded) {
    const active = state.engine.state === "ready" && state.engine.modelId === m.id;
    if (!active) {
      actions.append(
        button("Use", "btn-primary", () => {
          void (async () => {
            await engineHost?.setModelOverride(m.id);
            await refreshModels();
          })();
        })
      );
    } else {
      actions.append(el("span", "engine-model-active", "active"));
    }
    actions.append(
      button("Delete", "btn-ghost", () => {
        void (async () => {
          if (!engineHost) return;
          await engineHost.delete(m.id);
          if (engineHost.getModelOverride() === m.id) await engineHost.setModelOverride("auto");
          appendSystem(`Deleted on-device model ${shortModelName(m.id)}.`);
          await refreshModels();
        })();
      })
    );
  } else {
    const dl = button(
      webgpu ? `Download ${formatBytes(m.sizeBytes)}` : "Needs WebGPU",
      m.recommended ? "btn-primary" : "btn-ghost",
      () => void startDownload(m)
    );
    dl.disabled = !webgpu || state.downloadingId !== null;
    actions.append(dl);
  }
  row.append(actions);
  return row;
}

// --- Machine Check ---------------------------------------------------------------

function renderMachineCheck(models: WebLlmModelList): HTMLElement {
  const box = el("div", "vd-bench");
  const head = el("div", "vd-bench-head");
  head.append(el("strong", undefined, "Machine Check"));
  const run = button(state.bench.running ? "Checking…" : state.bench.result ? "Check again" : "Check this machine", "btn-ghost", () => void runBenchmark());
  run.disabled = state.bench.running || !engineHost;
  run.title = "Times a short, fixed generation on the model that would answer right now. Runs on this machine only.";
  head.append(run);
  box.append(head);
  const result = state.bench.result;
  if (state.bench.running) {
    box.append(el("p", "engine-panel-note", "Running a short test generation on this machine…"));
    return box;
  }
  if (!result) {
    box.append(el("p", "engine-panel-note", "See how fast on-device answers are here, and which model suits this machine."));
    return box;
  }
  if (!result.ok) {
    box.append(el("p", "engine-panel-note vd-bench-fail", describeBenchmarkFailure(result.reason)));
    return box;
  }
  const rows = el("dl", "vd-bench-rows");
  const addRow = (k: string, v: string) => rows.append(el("dt", undefined, k), el("dd", undefined, v));
  if (typeof result.firstTokenMs === "number") addRow("First token", `${Math.round(result.firstTokenMs).toLocaleString()} ms`);
  if (typeof result.tokensPerSecond === "number") {
    addRow("Speed", `${result.estimated ? "about " : ""}${result.tokensPerSecond.toFixed(1)} tokens/s${result.estimated ? " (estimated from characters)" : ""}`);
  }
  if (result.modelId || result.backend) {
    addRow("Measured on", `${result.modelId ? shortModelName(result.modelId) : "the active model"}${result.backend ? ` (${result.backend})` : ""}`);
  }
  box.append(rows);
  if (result.verdict) box.append(el("p", "vd-bench-verdict", result.verdict));
  const rec = result.recommendModelId;
  if (rec && rec !== state.engine.modelId) {
    const m = models.models.find((x) => x.id === rec);
    const line = el("div", "vd-bench-rec");
    line.append(el("span", undefined, `Recommended for this machine: ${m?.displayName || shortModelName(rec)}`));
    if (m && !m.downloaded) {
      const dl = button(`Download ${formatBytes(m.sizeBytes)}`, "btn-primary", () => void startDownload(m));
      dl.disabled = !models.webgpu || state.downloadingId !== null;
      line.append(dl);
    } else if (m?.downloaded) {
      line.append(
        button("Use it", "btn-primary", () => {
          void (async () => {
            await engineHost?.setModelOverride(m.id);
            await refreshModels();
          })();
        })
      );
    }
    box.append(line);
  }
  return box;
}

async function runBenchmark(): Promise<void> {
  if (!engineHost || state.bench.running) return;
  state.bench = { running: true, result: null };
  if (state.modelsOpen) renderModels();
  let result: BenchmarkResult;
  try {
    result = await engineHost.benchmark();
  } catch {
    // benchmark() never rejects by contract - belt-and-braces.
    result = { ok: false, reason: "generation-failed" };
  }
  if (!result || typeof result !== "object") result = { ok: false, reason: "generation-failed" };
  state.bench = { running: false, result };
  if (state.modelsOpen) renderModels();
}

async function startDownload(m: WebLlmModelInfo): Promise<void> {
  if (!engineHost || state.downloadingId) return;
  state.downloadingId = m.id;
  renderModels();
  const before = state.engine;
  await engineHost.download(m.id);
  state.downloadingId = null;
  await refreshModels();
  const now = state.models?.models.find((x) => x.id === m.id);
  if (now?.downloaded) {
    appendSystem(
      `${shortModelName(m.id)} is ready on this device. ` +
        (state.auth.signedIn
          ? 'Use the "Hosted / On-device" switch above to answer locally.'
          : "You can chat without signing in - everything runs here.")
    );
  } else {
    const detail =
      state.engine.state !== "ready" && state.engine.detail ? state.engine.detail : before.detail;
    appendSystem(`Download of ${shortModelName(m.id)} did not complete${detail ? ` (${detail})` : ""}. Try again.`, "error");
  }
}

// --- message list -------------------------------------------------------------------

/** True while the person has scrolled away from the bottom - streaming then
 * stops yanking the view down. */
let userScrolledUp = false;

function messagesEl(): HTMLElement {
  return $("messages");
}

function scrollToBottom(force = false): void {
  const list = messagesEl();
  if (force) userScrolledUp = false;
  // The home screen reads from the top; only conversations stick to the end.
  if (document.getElementById("vd-welcome")) {
    list.scrollTop = 0;
    return;
  }
  if (!userScrolledUp) list.scrollTop = list.scrollHeight;
}

function appendNode(node: HTMLElement): void {
  document.getElementById("vd-welcome")?.remove();
  messagesEl().append(node);
  scrollToBottom();
}

/** System notes (workflow cards, sandbox runs, notices). Returns the body so
 * callers can update it in place. */
function appendSystem(text: string, tone: "info" | "error" = "info"): HTMLElement {
  const item = el("div", `msg msg-system${tone === "error" ? " msg-error" : ""}`);
  const body = el("div", "msg-body", text);
  item.append(body);
  appendNode(item);
  return body;
}

function appendUser(text: string, contextLabels: string[] = []): HTMLElement {
  const item = el("div", "msg msg-user");
  const body = el("div", "msg-body", text);
  if (contextLabels.length) {
    const chips = el("div", "msg-context");
    for (const label of contextLabels) {
      const chip = el("span", "vd-chip vd-chip-static");
      chip.append(icon("clip"), el("span", "vd-chip-label", label));
      chips.append(chip);
    }
    body.append(chips);
  }
  item.append(body);
  appendNode(item);
  return item;
}

/** Adapter so markdown.ts (which only knows a tiny DOM surface) renders into
 * the real document. */
const mdDocument: MdDocument = {
  createElement: (tag: string) => document.createElement(tag) as unknown as MdElement,
  createTextNode: (text: string) => document.createTextNode(text),
};

function codeActions(code: string, lang: string, closed: boolean): MdElement[] {
  if (!closed) return [];
  const out: HTMLButtonElement[] = [];
  const copy = button("Copy", "md-codebtn", () => {
    transport.post({ type: "ui.copy", text: code });
    flash(copy, "Copied");
  });
  out.push(copy);
  const languageId = fenceLangToLanguageId(lang);
  if (state.capabilities.insert) {
    const insert = button("Insert", "md-codebtn", () => {
      transport.post({ type: "ui.insert", text: code });
      flash(insert, "Inserted");
    });
    insert.title = "Insert at the cursor in the active editor";
    out.push(insert);
  }
  if (state.capabilities.newFile) {
    const nf = button("New file", "md-codebtn", () => transport.post({ type: "ui.newFile", text: code, languageId }));
    nf.title = "Open this code in a new editor tab";
    out.push(nf);
  }
  if (state.capabilities.runCode && state.auth.signedIn && !state.privateMode && toSandboxLanguage(languageId)) {
    const run = button("Run", "md-codebtn", () => runCode(code, languageId));
    run.title = "Run in a disposable cloud sandbox (needs the agent-builder or tenant-admin role)";
    out.push(run);
  }
  return out as unknown as MdElement[];
}

interface AssistantView {
  item: HTMLElement;
  body: HTMLElement;
  text: string;
  setText(text: string, final: boolean): void;
  showError(message: string): void;
  finish(opts: { command?: string; retryable: boolean; req?: OutgoingRequest; standalone?: boolean }): void;
}

const RENDER_THROTTLE_MS = 60;

/** An assistant message. With `container` it is placed there (Second
 * Opinion's columns) instead of at the end of the thread. */
function createAssistantView(container?: HTMLElement): AssistantView {
  const item = el("div", "msg msg-assistant");
  const body = el("div", "msg-body md");
  const typing = el("span", "vd-typing");
  typing.setAttribute("aria-label", "Generating");
  typing.append(el("i"), el("i"), el("i"));
  body.append(typing);
  item.append(body);
  if (container) {
    container.append(item);
    scrollToBottom();
  } else {
    appendNode(item);
  }

  const md = createMarkdownView(mdDocument, {
    onLink: (href) => transport.post({ type: "ui.openExternal", url: href }),
    codeActions,
  });
  let timer: number | null = null;

  const view: AssistantView = {
    item,
    body,
    text: "",
    setText(text: string, final: boolean) {
      view.text = text;
      const render = () => {
        timer = null;
        const nodes = md.update(view.text) as unknown as Node[];
        if (nodes.length === 0 && !final) return;
        body.replaceChildren(...nodes);
        scrollToBottom();
      };
      if (final) {
        if (timer !== null) window.clearTimeout(timer);
        render();
      } else if (timer === null) {
        timer = window.setTimeout(render, RENDER_THROTTLE_MS);
      }
    },
    showError(message: string) {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      item.classList.add("msg-error");
      const err = el("div", "msg-error-text", message);
      if (view.text) {
        body.replaceChildren(...(md.update(view.text) as unknown as Node[]), err);
      } else {
        body.replaceChildren(err);
      }
      scrollToBottom();
    },
    finish({ command, retryable, req, standalone }) {
      body.querySelector(".vd-typing")?.remove();
      item.querySelector(".msg-actions")?.remove();
      item.querySelector(".vd-tour")?.remove();
      if (command === "tour" && view.text && !item.classList.contains("msg-error")) {
        renderTour(view, req?.tour);
      }
      const actions = el("div", "msg-actions");
      if (view.text) {
        const copy = el("button", "vd-action");
        copy.type = "button";
        copy.append(icon("copy"), el("span", undefined, "Copy"));
        copy.addEventListener("click", () => {
          transport.post({ type: "ui.copy", text: view.text });
          const label = copy.querySelector("span");
          if (label) {
            label.textContent = "Copied";
            window.setTimeout(() => (label.textContent = "Copy"), 1400);
          }
        });
        actions.append(copy);
      }
      if (command === "commit" && state.capabilities.commitMessage && view.text) {
        const use = button("Use as commit message", "vd-action vd-action-primary", () => {
          const msg = extractCommitMessage(view.text);
          transport.post({ type: "ui.setCommitMessage", text: msg });
          flash(use, "Added to commit box");
        });
        use.title = "Put this message in the commit box. Nothing is committed - you review and commit.";
        actions.append(use);
      }
      const recipe = command?.startsWith("recipe:") ? findRecipe(command.slice("recipe:".length)) : undefined;
      if (recipe && view.text) appendRecipeActions(actions, recipe, view);
      if (view.text && !standalone && !item.classList.contains("msg-help")) {
        appendWorkflowAction(actions, view, recipe?.output?.offerWorkflow === true);
      }
      if (req?.duck && view.text && !wantsTheAnswer(req.display)) {
        const tell = button("Just tell me", "vd-action", () => {
          if (busy()) {
            setNotice("Wait for the current answer to finish, or press Esc to stop it.");
            return;
          }
          composerInput().value = "Just tell me the answer.";
          submit();
        });
        tell.title = "Leave rubber-duck questioning and get the answer";
        actions.append(tell);
      }
      if (retryable) {
        const retry = el("button", "vd-action vd-retry");
        retry.type = "button";
        retry.append(icon("retry"), el("span", undefined, "Retry"));
        retry.addEventListener("click", () => retryLast());
        actions.append(retry);
      }
      if (actions.childElementCount) item.append(actions);
    },
  };
  return view;
}

// --- answer actions: recipe outputs, workflows, Code Tour ---------------------------

function defaultLanguageFor(output: RecipeOutput): string | undefined {
  if (output.languageId) return output.languageId;
  switch (output.kind) {
    case "markdown":
      return "markdown";
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "mermaid":
      return "mermaid";
    default:
      return undefined;
  }
}

/** The part of an answer worth putting in a file: the first fenced block for
 * code-shaped outputs, else the whole answer. */
function recipeFileText(output: RecipeOutput, answer: string): { text: string; languageId?: string } {
  if (output.kind !== "markdown") {
    const block = firstCodeBlock(answer);
    if (block) return { text: block.code, languageId: defaultLanguageFor(output) ?? fenceLangToLanguageId(block.lang) };
  }
  return { text: answer, languageId: defaultLanguageFor(output) };
}

function appendRecipeActions(actions: HTMLElement, recipe: Recipe, view: AssistantView): void {
  const output = recipe.output;
  if (!output) return;
  if (output.offerNewFile) {
    const nf = button(
      state.capabilities.newFile ? "Open as new file" : "Copy for a new file",
      "vd-action vd-action-primary",
      () => {
        const file = recipeFileText(output, view.text);
        if (state.capabilities.newFile) {
          transport.post({ type: "ui.newFile", text: file.text, languageId: file.languageId });
          flash(nf, "Opened");
        } else {
          transport.post({ type: "ui.copy", text: file.text });
          flash(nf, "Copied");
        }
      }
    );
    nf.title = state.capabilities.newFile ? "Open the result in a new editor tab" : "This host has no editor - the result is copied instead";
    actions.append(nf);
  }
  if (output.offerCommitMessage && state.capabilities.commitMessage) {
    const use = button("Use as commit message", "vd-action vd-action-primary", () => {
      transport.post({ type: "ui.setCommitMessage", text: extractCommitMessage(view.text) });
      flash(use, "Added to commit box");
    });
    use.title = "Put this message in the commit box. Nothing is committed - you review and commit.";
    actions.append(use);
  }
}

/** "Run a workflow with this": pick a workflow, send the answer as its input. */
function appendWorkflowAction(actions: HTMLElement, view: AssistantView, primary: boolean): void {
  if (!workflowOk()) return;
  const open = button("Run a workflow", `vd-action${primary ? " vd-action-primary" : ""}`, () => {
    if (!workflowOk()) {
      setNotice(state.privateMode ? "Workflows run on the server, so they are off while Private Mode is on." : "Sign in to run workflows.", "error");
      return;
    }
    const picker = el("select", "vd-wf-picker");
    picker.setAttribute("aria-label", "Workflow to run with this answer");
    const ph = el("option", undefined, "Run which workflow with this answer?");
    ph.value = "";
    picker.append(ph);
    for (const wf of state.workflows) {
      const o = el("option", undefined, wf.name);
      o.value = wf.id;
      picker.append(o);
    }
    picker.addEventListener("change", () => {
      if (picker.value) runWorkflow(picker.value, view.text);
      picker.replaceWith(open);
    });
    picker.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        picker.replaceWith(open);
        open.focus();
      }
    });
    open.replaceWith(picker);
    picker.focus();
  });
  open.title = "Send this answer as the input of one of your workflows";
  actions.append(open);
}

/** Replace a Code Tour answer's JSON block with a clickable stop list. With
 * no `meta` (a tour restored from history) the stops are shown as text. */
function renderTour(view: AssistantView, meta: OutgoingRequest["tour"]): void {
  const stops = parseTourStops(view.text, meta?.lineCount ?? Number.POSITIVE_INFINITY);
  const box = el("div", "vd-tour");
  if (stops.length === 0) {
    box.append(
      el(
        "p",
        "vd-tour-note",
        "Couldn't read tour stops from this answer. Try /tour again - a larger model follows the stop format more reliably."
      )
    );
    view.item.append(box);
    return;
  }
  const prose = tourProse(view.text);
  if (prose) {
    view.setText(prose, true);
  } else {
    view.body.replaceChildren();
  }
  const canReveal = state.capabilities.reveal === true && meta !== undefined;
  box.append(el("div", "vd-tour-title", `Code Tour${meta?.path ? ` · ${meta.path}` : ""} · ${stops.length} stops`));
  const list = el("ol", "vd-tour-list");
  stops.forEach((stop: TourStop, i: number) => {
    const li = el("li", "vd-tour-stop");
    const head = canReveal ? el("button", "vd-tour-jump") : el("div", "vd-tour-jump vd-tour-static");
    head.append(el("span", "vd-tour-num", String(i + 1)), el("span", "vd-tour-stop-title", stop.title), el("span", "vd-tour-range", formatStopRange(stop)));
    if (canReveal && head instanceof HTMLButtonElement) {
      head.type = "button";
      head.title = `Show ${formatStopRange(stop).toLowerCase()} in the editor`;
      head.addEventListener("click", () => {
        transport.post({ type: "ui.reveal", path: meta?.path, startLine: stop.startLine, endLine: stop.endLine });
        for (const other of Array.from(list.querySelectorAll(".vd-tour-current"))) other.classList.remove("vd-tour-current");
        li.classList.add("vd-tour-current");
      });
    }
    li.append(head);
    if (stop.explanation) li.append(el("p", "vd-tour-text", stop.explanation));
    list.append(li);
  });
  box.append(list);
  if (!canReveal) {
    box.append(
      el(
        "p",
        "vd-tour-note",
        meta ? "This host can't jump to lines, so use the line numbers above." : "Restored from history - use the line numbers above."
      )
    );
  }
  view.item.append(box);
}

/** Only the newest assistant message keeps its Retry button. */
function clearRetryButtons(): void {
  for (const b of Array.from(messagesEl().querySelectorAll(".vd-retry"))) b.remove();
}

// --- welcome / empty state ------------------------------------------------------------

function hasConversation(): boolean {
  return messagesEl().querySelector(".msg") !== null;
}

interface QuickStart {
  title: string;
  detail: string;
  icon?: string;
  run: () => void;
}

function quickStarts(): QuickStart[] {
  const cards: QuickStart[] = [];
  const caps = state.capabilities;
  const compose = true; // always listening: a quick start parks until something can answer
  if (compose && caps.context.includes("selection")) {
    cards.push({
      title: "Explain selection", icon: "code",
      detail: state.platform === "chrome" ? "Explain the text you have selected" : "Walk through the code you have selected",
      run: () => runCommand("explain"),
    });
  }
  if (compose && caps.context.includes("diff")) {
    cards.push({ title: "Review my changes", icon: "eye", detail: "A careful review of your uncommitted diff", run: () => runCommand("review") });
    if (caps.commitMessage) {
      cards.push({ title: "Write a commit message", icon: "commit", detail: "From your diff, straight into the commit box", run: () => runCommand("commit") });
    }
  }
  if (compose && caps.context.includes("diagnostics") && caps.context.includes("selection")) {
    cards.push({ title: "Fix a problem", icon: "wrench", detail: "Use the editor's errors to fix the selection", run: () => runCommand("fix") });
  }
  if (compose && caps.context.includes("page")) {
    cards.push({ title: "Summarize this page", icon: "globe", detail: "Key points of the tab you're reading", run: () => runCommand("summarize") });
  }
  if (compose && caps.context.includes("file")) {
    cards.push({ title: "Code Tour", icon: "map", detail: "A guided walk through the current file, stop by stop", run: () => runCommand("tour") });
  }
  if (compose && knowledgeOk()) {
    cards.push({
      title: "Ask the team", icon: "users",
      detail: "Answers from your team's knowledge base, with sources",
      run: () => {
        const input = composerInput();
        input.value = "/ask-team ";
        input.focus();
      },
    });
  }
  cards.push({
    title: "Open the Toolkit", icon: "grid",
    detail: `Ready-made recipes for ${roleLabel(currentRole())} work, across the whole SDLC`,
    run: () => toggleToolkit(true),
  });
  if (state.hostLocalEngine && !engineReady()) {
    cards.push({
      title: "Download a free on-device model", icon: "chip",
      detail: "Private and free: runs on this machine, no account needed",
      run: () => void toggleModels(true),
    });
  }
  if (!state.auth.signedIn) {
    cards.push({
      title: "Sign in for your team's agents", icon: "key",
      detail: "Chat with your agents and run workflows",
      run: () => transport.post({ type: "auth.signIn" }),
    });
  } else if (state.workflows.length > 0 && !state.privateMode) {
    cards.push({
      title: "Run a workflow", icon: "rocket",
      detail: `${state.workflows.length} available to you`,
      run: () => ($("workflow-select") as HTMLSelectElement).focus(),
    });
  }
  return cards;
}

const ROLE_ICONS: Record<Role, string> = {
  developer: "code",
  tester: "flask",
  reviewer: "eye",
  architect: "layers",
  product: "target",
  devops: "rocket",
};

/** Things worth typing, per role - one click sends (or holds) them. */
const TRY_ASKING: Record<Role, string[]> = {
  developer: [
    "Explain the difference between debounce and throttle, with code",
    "Write a TypeScript function that retries a fetch with exponential backoff",
    "What are the tradeoffs of optimistic UI updates?",
  ],
  tester: [
    "Give me boundary-value test cases for an age field that accepts 18-65",
    "Write a Playwright test that logs in and checks the dashboard loads",
    "How do I make flaky end-to-end tests reliable?",
  ],
  reviewer: [
    "What should I look for when reviewing a database migration?",
    "Checklist for reviewing an authentication change",
    "How do I give review feedback that lands well?",
  ],
  architect: [
    "Compare event sourcing and CRUD for an order service",
    "Draw a Mermaid sequence diagram for OAuth device sign-in",
    "When is a modular monolith better than microservices?",
  ],
  product: [
    "Turn 'users can reset their password' into a story with acceptance criteria",
    "What metrics would show a new onboarding flow is working?",
    "Write release notes for a faster search feature",
  ],
  devops: [
    "Write a GitHub Actions workflow that tests and builds a Node app",
    "How do I roll back a Kubernetes deployment safely?",
    "Draft an incident post-mortem template",
  ],
};

const TIPS = [
  "Type / in the box to see every command.",
  "Private Mode (shield icon) keeps prompts, code and searches on this machine.",
  "Instant tools (bolt icon) work offline: JSON, JWT, regex, cron, hashes and more.",
  "Rubber duck mode asks you questions until you find the answer yourself.",
  "Second opinion runs your question on-device and on your agent, side by side.",
  "Build your own recipes in the Toolkit and share them as a file with your team.",
  "Messages you send before signing in are held, then answered automatically.",
];

function greeting(): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const name = state.auth.signedIn && state.auth.username ? state.auth.username.split(/[\s@]/)[0] : "";
  return name ? `${part}, ${name}` : `${part}`;
}

function section(title: string, extra?: HTMLElement): HTMLElement {
  const box = el("section", "vd-home-section");
  const head = el("div", "vd-home-head");
  head.append(el("h2", "vd-home-title", title));
  if (extra) head.append(extra);
  box.append(head);
  return box;
}

/** The home screen - full before sign-in too: a live engine card, one-click
 * starts, things to ask, offline tools, recipes for the person's role, a tip. */
function renderWelcome(): void {
  if (!document.getElementById("messages")) return;
  if (hasConversation() || state.parked) {
    document.getElementById("vd-welcome")?.remove();
    return;
  }
  let welcome = document.getElementById("vd-welcome");
  if (!welcome) {
    welcome = el("section", "vd-welcome");
    welcome.id = "vd-welcome";
    messagesEl().append(welcome);
  }
  welcome.textContent = "";

  // Hero.
  const hero = el("div", "vd-welcome-hero");
  const orb = el("div", "vd-hero-orb");
  orb.append(el("span", "vd-hero-ring"), brandMark(54, "vd-welcome-emblem"));
  hero.append(orb, el("h1", "vd-welcome-title", greeting()));
  hero.append(
    el(
      "p",
      "vd-welcome-tagline",
      state.platform === "chrome"
        ? "Your AI co-pilot for the web. Ask, summarize, translate - privately on this device or with your team's agents."
        : "Your AI pair for the whole SDLC. Code, tests, reviews, designs and releases - on this device or with your team's agents."
    )
  );
  const pills = el("div", "vd-pills");
  const pill = (text: string, tone: "ok" | "warn" | "info" | "accent") => pills.append(el("span", `vd-pill vd-pill-${tone}`, text));
  pill(state.auth.signedIn ? `Signed in${state.auth.username ? ` · ${state.auth.username}` : ""}` : "No account needed", state.auth.signedIn ? "ok" : "accent");
  if (engineReady()) pill(`On-device · ${state.engine.modelId ? shortModelName(state.engine.modelId) : "ready"}`, "ok");
  else if (state.engine.state === "loading") pill(`Loading model ${Math.round((state.engine.progress ?? 0) * 100)}%`, "warn");
  if (state.privateMode) pill("Private Mode", "info");
  pill(`${INSTANT_TOOLS.length} offline tools`, "info");
  hero.append(pills);
  welcome.append(hero);

  if (!state.onboarded) {
    welcome.append(renderRolePicker());
    return;
  }
  const role = currentRole();

  // Engine card: the fastest path to a free, private answer.
  const engineCard = renderEngineCard();
  if (engineCard) welcome.append(engineCard);

  // Quick starts.
  const cards = quickStarts();
  if (cards.length) {
    const change = button(`${roleLabel(role)} · change`, "vd-link-btn", () => {
      state.onboarded = false;
      renderWelcome();
    });
    const box = section("Start here", change);
    const grid = el("div", "vd-cards");
    cards.forEach((card, i) => {
      const b = el("button", `vd-card vd-hue-${i % 6}`);
      b.type = "button";
      const ic = el("span", "vd-card-icon");
      ic.append(icon(card.icon ?? "spark"));
      const text = el("span", "vd-card-text");
      text.append(el("span", "vd-card-title", card.title), el("span", "vd-card-detail", card.detail));
      b.append(ic, text);
      b.addEventListener("click", card.run);
      grid.append(b);
    });
    box.append(grid);
    welcome.append(box);
  }

  // Try asking.
  const ask = section("Try asking");
  const asks = el("div", "vd-asks");
  for (const q of TRY_ASKING[role]) {
    const b = el("button", "vd-ask");
    b.type = "button";
    b.append(icon("spark"), el("span", undefined, q));
    b.addEventListener("click", () => {
      const input = composerInput();
      input.value = q;
      submit();
    });
    asks.append(b);
  }
  ask.append(asks);
  welcome.append(ask);

  // Instant tools.
  const allTools = button(`All ${INSTANT_TOOLS.length}`, "vd-link-btn", () => toggleTools(true));
  const tools = section("Instant tools · offline", allTools);
  const tgrid = el("div", "vd-tool-strip");
  for (const id of ["json", "jwt-decode", "regex", "cron-explain", "timestamp", "test-data"]) {
    const t = findInstantTool(id);
    if (!t) continue;
    tgrid.append(toolTile(t, true));
  }
  tools.append(tgrid);
  welcome.append(tools);

  // Recipe spotlight for the role.
  const spotlight = allRecipes()
    .filter((r) => r.roles[0] === role && recipeAvailable(r, state.capabilities))
    .slice(0, 3);
  if (spotlight.length) {
    const box = section(`Recipes for ${roleLabel(role)}`, button("Toolkit", "vd-link-btn", () => toggleToolkit(true)));
    const list = el("div", "vd-spot");
    for (const r of spotlight) {
      const b = el("button", "vd-spot-item");
      b.type = "button";
      b.append(el("span", "vd-spot-phase", phaseLabel(r.phase)), el("span", "vd-spot-name", r.name), el("span", "vd-spot-desc", r.description));
      b.addEventListener("click", () => pickRecipe(r));
      list.append(b);
    }
    box.append(list);
    welcome.append(box);
  }

  const tip = el("p", "vd-tip");
  tip.append(el("strong", undefined, "Tip  "), el("span", undefined, TIPS[new Date().getDate() % TIPS.length]));
  welcome.append(tip);
}

/** On-device AI status as a card: download (one click), loading, or ready. */
function renderEngineCard(): HTMLElement | null {
  if (!state.hostLocalEngine) return null;
  const card = el("div", "vd-engine-card");
  const ic = el("span", "vd-engine-icon");
  ic.append(icon("chip"));
  const text = el("div", "vd-engine-text");
  const actions = el("div", "vd-engine-actions");
  if (engineReady()) {
    card.classList.add("vd-engine-ready");
    text.append(
      el("strong", undefined, `On-device AI is ready`),
      el("span", undefined, `${state.engine.modelId ? shortModelName(state.engine.modelId) : "Local model"} · private · works offline`)
    );
    actions.append(button("Models", "btn-ghost", () => void toggleModels(true)));
  } else if (state.engine.state === "loading" || state.downloadingId) {
    const pct = Math.round((state.engine.progress ?? 0) * 100);
    text.append(el("strong", undefined, `Getting your model ready… ${pct}%`), el("span", undefined, "You can keep typing - I'll answer when it's done."));
    const bar = el("div", "engine-progress");
    const fill = el("div", "engine-progress-fill");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    text.append(bar);
  } else {
    const pick = state.models ? pickQuickModel(state.models.models) : undefined;
    text.append(
      el("strong", undefined, "Free AI that runs on this machine"),
      el(
        "span",
        undefined,
        pick
          ? `${shortModelName(pick.id)}${pick.sizeBytes ? ` · ${formatBytes(pick.sizeBytes)} once` : ""} · private · no account`
          : "Private, no account, nothing leaves your machine"
      )
    );
    const go = el("button", "btn-primary");
    go.type = "button";
    go.append(icon("bolt"), el("span", undefined, pick?.downloaded ? "Use it" : "Get it"));
    go.addEventListener("click", () => void quickLocalModel());
    actions.append(go, button("Choose", "btn-ghost", () => void toggleModels(true)));
    if (!state.models && engineHost) {
      void engineHost.listModels().then((list) => {
        state.models = list;
        renderWelcome();
      });
    }
  }
  card.append(ic, text, actions);
  return card;
}

/** First run: one friendly step - who is this for? Persisted; changeable
 * from Help, the Toolkit and the welcome screen. */
function renderRolePicker(): HTMLElement {
  const box = el("div", "vd-roles");
  box.append(el("h2", "vd-roles-title", "What best describes your work?"));
  box.append(el("p", "vd-roles-sub", "VegaDūta puts the tools you'll use most first. You can change this any time."));
  const grid = el("div", "vd-role-grid");
  for (const r of ROLES) {
    const b = el("button", `vd-role${state.role === r.id ? " vd-role-current" : ""}`);
    b.type = "button";
    const ic = el("span", "vd-card-icon");
    ic.append(icon(ROLE_ICONS[r.id]));
    b.append(ic, el("span", "vd-card-title", r.label), el("span", "vd-card-detail", r.blurb));
    b.addEventListener("click", () => setRole(r.id));
    grid.append(b);
  }
  box.append(grid);
  box.append(
    button("Skip for now", "vd-link-btn vd-roles-skip", () => {
      state.onboarded = true;
      persistPrefs();
      renderWelcome();
    })
  );
  return box;
}

function setRole(role: Role): void {
  state.role = role;
  state.onboarded = true;
  persistPrefs();
  renderWelcome();
  if (state.toolkitOpen) renderToolkit();
}

function roleSelect(onChange: (role: Role) => void): HTMLSelectElement {
  const select = el("select", "vd-role-select");
  select.setAttribute("aria-label", "Your role");
  for (const r of ROLES) {
    const o = el("option", undefined, r.label);
    o.value = r.id;
    select.append(o);
  }
  select.value = currentRole();
  select.addEventListener("change", () => onChange(select.value as Role));
  return select;
}

// --- help -------------------------------------------------------------------------------

function showHelp(): void {
  const cmds = commandsHere();
  const lines: string[] = ["### What VegaDūta can do here", ""];
  lines.push(
    "- **Hosted chat** - sign in to talk to your team's agents and run workflows from the toolbar.",
    state.hostLocalEngine
      ? "- **On-device chat** - download a free model from the on-device chip; the model runs on this machine with no account."
      : "- **On-device chat** is not available in this host.",
    "- **Toolkit** (grid icon, or `/toolkit`) - ready-made recipes for every SDLC phase, plus your own. Create, import and export them there.",
    "- **Private Mode** (shield icon) - no prompt, code, attachment, page text or search query leaves this machine. Allowed: your own local model server, on-device inference, and model downloads you click. Blocked: hosted chat, completions and commands, team knowledge search, the code sandbox, workflows and code validation.",
    "- **Rubber duck** - the assistant asks one question at a time to help you find the answer; say *just tell me* for the answer.",
    "- **Second opinion** - when signed in with an on-device model ready, compare this machine's answer with your agent's, side by side.",
    "- **Run a workflow with this** - on any answer, send it as the input of one of your workflows.",
    ""
  );
  if (state.capabilities.context.length) {
    lines.push(
      `**Context** - use **Attach** to add ${state.capabilities.context.map((k) => CONTEXT_KIND_LABELS[k].label.toLowerCase()).join(", ")} to your next message.`,
      ""
    );
  }
  lines.push("**Commands** - type `/` in the box below:", "");
  for (const c of cmds) lines.push(`- \`/${c.name}\` - ${c.description}`);
  lines.push(
    "",
    "**Keys** - `Enter` sends, `Shift+Enter` adds a line, `Esc` stops an answer, arrow keys move through the command list."
  );
  const view = createAssistantView();
  view.item.classList.add("msg-help");
  view.setText(lines.join("\n"), true);
  view.finish({ retryable: false });
  const roleRow = el("label", "vd-role-row");
  roleRow.append(el("span", undefined, "Tools are ordered for"), roleSelect((role) => setRole(role)));
  view.item.append(roleRow);
}

// --- history ------------------------------------------------------------------------------

function toggleHistory(open?: boolean): void {
  state.historyOpen = open ?? !state.historyOpen;
  if (state.historyOpen) closeOtherDrawers("history");
  renderHistory();
  syncDrawerLayout();
}

type Drawer = "models" | "history" | "toolkit" | "tools";

/** One drawer at a time: opening one closes the rest, so no panel is ever
 * cut off by another. */
function closeOtherDrawers(keep: Drawer): void {
  if (keep !== "models" && state.modelsOpen) void toggleModels(false);
  if (keep !== "history" && state.historyOpen) toggleHistory(false);
  if (keep !== "toolkit" && state.toolkitOpen) toggleToolkit(false);
  if (keep !== "tools" && state.toolsOpen) toggleTools(false);
}

/** While a drawer is open it takes the conversation's space (the conversation
 * is kept, just not shown), so the header, account bar and composer always
 * stay fully visible and the drawer scrolls within what is left. */
function syncDrawerLayout(): void {
  const open = state.modelsOpen || state.historyOpen || state.toolkitOpen || state.toolsOpen;
  document.body.classList.toggle("vd-drawer-open", open);
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderHistory(): void {
  let panel = document.getElementById("vd-history");
  if (!state.historyOpen) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = el("section", "vd-history");
    panel.id = "vd-history";
    panel.setAttribute("aria-label", "Conversation history");
    messagesEl().before(panel);
  }
  panel.textContent = "";
  const head = el("div", "vd-history-head");
  head.append(el("strong", undefined, "Conversations"));
  const headActions = el("div", "vd-history-head-actions");
  headActions.append(
    button("New chat", "btn-ghost", () => {
      newChat();
      toggleHistory(false);
    }),
    iconButton("close", "Close history", () => toggleHistory(false))
  );
  head.append(headActions);
  panel.append(head);

  const threads = history.list();
  if (!history.persistent) {
    panel.append(el("p", "vd-history-note", "This window can't save history (storage is blocked), so conversations last until it closes."));
  }
  if (threads.length === 0) {
    panel.append(el("p", "vd-history-note", "No saved conversations yet. They're kept on this device only."));
    return;
  }
  const list = el("ul", "vd-history-list");
  for (const t of threads) {
    const li = el("li", `vd-history-item${thread?.id === t.id ? " vd-history-current" : ""}`);
    const open = el("button", "vd-history-open");
    open.type = "button";
    open.append(el("span", "vd-history-title", t.title));
    const meta = el("span", "vd-history-meta", `${t.mode === "local" ? "On-device" : "Hosted"} · ${relativeTime(t.updatedAt)}`);
    open.append(meta);
    open.disabled = busy();
    open.addEventListener("click", () => {
      openThread(t.id);
      toggleHistory(false);
    });
    const del = iconButton("trash", `Delete "${t.title}"`, () => {
      history.delete(t.id);
      if (thread?.id === t.id) newChat();
      renderHistory();
    });
    li.append(open, del);
    list.append(li);
  }
  panel.append(list);
  const clear = button("Delete all conversations", "btn-ghost vd-history-clear", () => {
    history.clearAll();
    newChat();
    renderHistory();
  });
  panel.append(clear);
  panel.append(el("p", "vd-history-note", "Saved on this device only. Attached file, diff and page contents are never saved - only their names."));
}

/** Clears the view (not the stored history) and starts a fresh thread lazily. */
function newChat(): void {
  if (state.streamingReqId) abortCurrent();
  thread = null;
  localTurns.length = 0;
  lastRequest = null;
  const list = messagesEl();
  for (const node of Array.from(list.querySelectorAll(".msg"))) node.remove();
  workflowCards.clear();
  runResults.clear();
  userScrolledUp = false;
  renderWelcome();
  renderHistory();
  composerInput().focus();
}

function openThread(id: string): void {
  const t = history.get(id);
  if (!t || busy()) return;
  newChat();
  thread = t;
  // Restore the mode the thread was held in, where that mode is possible.
  if (t.mode === "local" && state.auth.signedIn && engineReady()) {
    state.localMode = true;
    state.localModeChosen = true;
  } else if (t.mode === "hosted" && state.auth.signedIn) {
    state.localMode = false;
    state.localModeChosen = true;
    if (t.agentId && state.agents.some((a) => a.id === t.agentId)) {
      state.selectedAgentId = t.agentId;
      ($("agent-select") as HTMLSelectElement).value = t.agentId;
    }
  }
  for (const m of t.messages) renderStored(m);
  // Rebuild on-device memory from what was said (attachment bodies were never saved).
  if (t.mode === "local") {
    for (const m of t.messages) if (!m.error) localTurns.push({ role: m.role, content: m.text });
  }
  const modeNow = usingLocal() ? "local" : "hosted";
  if (modeNow !== t.mode) {
    appendSystem(
      t.mode === "local"
        ? "This was an on-device conversation. The on-device model isn't active now, so a new message will start a new hosted conversation."
        : "This was a hosted conversation. Sign in and switch to Hosted to continue it; a new message now starts an on-device conversation."
    );
  }
  renderLocalToggle();
  renderComposer();
  renderHistory();
  scrollToBottom(true);
}

function renderStored(m: StoredMessage): void {
  if (m.role === "user") {
    appendUser(m.text, m.context ?? []);
    return;
  }
  const view = createAssistantView();
  if (m.error) {
    view.showError(m.text);
  } else {
    view.setText(m.text, true);
  }
  view.finish({ command: m.command, retryable: false });
}

/** The thread new turns go to; a mode or agent change starts a new one. */
function ensureThread(mode: "hosted" | "local"): Thread {
  const agentId = mode === "hosted" ? state.selectedAgentId : null;
  if (thread && thread.mode === mode && (mode === "local" || thread.agentId === agentId)) return thread;
  if (thread && thread.messages.length > 0) {
    newChat();
    appendSystem(
      mode === "local"
        ? "Started a new on-device conversation - hosted and on-device conversations are kept separate."
        : "Started a new hosted conversation - hosted and on-device conversations are kept separate."
    );
  }
  thread = history.create(mode, agentId);
  return thread;
}

// --- Toolkit ----------------------------------------------------------------------------------

// --- Instant tools (offline) -----------------------------------------------------------

function toggleTools(open?: boolean): void {
  state.toolsOpen = open ?? !state.toolsOpen;
  if (state.toolsOpen) closeOtherDrawers("tools");
  renderTools();
  syncDrawerLayout();
  if (state.toolsOpen) (document.querySelector("#vd-tools input, #vd-tools textarea") as HTMLElement | null)?.focus();
}

function toolTile(t: InstantTool, compact = false): HTMLButtonElement {
  const b = el("button", `vd-tool vd-cat-${t.category}${compact ? " vd-tool-compact" : ""}`);
  b.type = "button";
  b.title = t.description;
  const ic = el("span", "vd-tool-icon");
  ic.append(icon(t.icon));
  const text = el("span", "vd-tool-text");
  text.append(el("span", "vd-tool-name", t.name));
  if (!compact) text.append(el("span", "vd-tool-desc", t.description));
  b.append(ic, text);
  b.addEventListener("click", () => {
    state.toolId = t.id;
    toggleTools(true);
  });
  return b;
}

function renderTools(): void {
  if (!state.toolsOpen) {
    document.getElementById("vd-tools")?.remove();
    return;
  }
  let panel = document.getElementById("vd-tools");
  if (!panel) {
    panel = el("section", "vd-tools");
    panel.id = "vd-tools";
    panel.setAttribute("aria-label", "Instant tools");
    messagesEl().before(panel);
  }
  panel.textContent = "";
  const tool = state.toolId ? findInstantTool(state.toolId) : undefined;
  const head = el("div", "vd-history-head");
  const title = el("div", "vd-tools-title");
  if (tool) {
    title.append(
      iconButton("back", "All tools", () => {
        state.toolId = null;
        renderTools();
      })
    );
  }
  title.append(el("strong", undefined, tool ? tool.name : "Instant tools"), el("span", "vd-pill vd-pill-ok", "offline"));
  head.append(title, iconButton("close", "Close instant tools", () => toggleTools(false)));
  panel.append(head);
  if (tool) renderToolRunner(panel, tool);
  else renderToolGallery(panel);
}

function renderToolGallery(panel: HTMLElement): void {
  panel.append(el("p", "vd-tools-sub", "Everyday developer utilities. They run right here - no account, no model, nothing sent anywhere."));
  const search = el("input", "vd-toolkit-search");
  search.type = "search";
  search.placeholder = "Search tools…";
  search.value = state.toolsQuery;
  search.setAttribute("aria-label", "Search tools");
  const listBox = el("div");
  const draw = () => {
    listBox.textContent = "";
    const q = state.toolsQuery.trim().toLowerCase();
    const groups = new Map<InstantCategory, InstantTool[]>();
    for (const t of INSTANT_TOOLS) {
      if (q && !`${t.name} ${t.description} ${t.id}`.toLowerCase().includes(q)) continue;
      const list = groups.get(t.category) ?? [];
      list.push(t);
      groups.set(t.category, list);
    }
    if (!groups.size) listBox.append(el("p", "vd-tools-sub", "No tool matches. Ask the AI instead - it's one message away."));
    for (const [cat, list] of groups) {
      listBox.append(el("div", "vd-toolkit-phase", INSTANT_CATEGORY_LABELS[cat]));
      const grid = el("div", "vd-tool-grid");
      for (const t of list) grid.append(toolTile(t));
      listBox.append(grid);
    }
  };
  search.addEventListener("input", () => {
    state.toolsQuery = search.value;
    draw();
  });
  draw();
  panel.append(search, listBox);
}

function renderToolRunner(panel: HTMLElement, tool: InstantTool): void {
  panel.append(el("p", "vd-tools-sub", tool.description));
  const opts: Record<string, string> = {};
  if (tool.options?.length) {
    const row = el("div", "vd-tool-options");
    for (const o of tool.options) {
      opts[o.id] = o.default;
      const label = el("label", "vd-tool-option");
      label.append(el("span", undefined, o.label));
      const select = el("select");
      for (const c of o.choices) {
        const option = el("option", undefined, c);
        option.value = c;
        if (c === o.default) option.selected = true;
        select.append(option);
      }
      select.addEventListener("change", () => {
        opts[o.id] = select.value;
        void run();
      });
      label.append(select);
      row.append(label);
    }
    panel.append(row);
  }
  const input = el("textarea", "vd-tool-input");
  input.placeholder = tool.placeholder;
  input.rows = 5;
  input.spellcheck = false;
  input.setAttribute("aria-label", `${tool.name} input`);
  const actions = el("div", "vd-tool-actions");
  const go = el("button", "btn-primary");
  go.type = "button";
  // Generators (UUIDs, passwords) take no input: label the button for what
  // it does and show a result straight away.
  const generator = !tool.sample;
  go.append(icon("play"), el("span", undefined, generator ? "Generate" : "Run"));
  actions.append(go);
  if (!generator) {
    actions.append(
      button("Try a sample", "btn-ghost", () => {
        input.value = tool.sample;
        void run();
      })
    );
  }
  actions.append(el("span", "vd-tool-kbd", "Ctrl+Enter"));
  const out = el("div", "vd-tool-output");
  out.hidden = true;

  let last = "";
  async function run(): Promise<void> {
    let result;
    try {
      result = await tool.run(input.value, { ...opts });
    } catch (e) {
      result = { ok: false, output: "", note: e instanceof Error ? e.message : String(e) };
    }
    last = result.output;
    out.hidden = false;
    out.textContent = "";
    out.classList.toggle("vd-tool-error", !result.ok);
    if (result.note) out.append(el("div", "vd-tool-note", result.note));
    if (result.output) {
      const pre = el("pre", "md-pre");
      pre.append(el("code", "md-code", result.output));
      out.append(pre);
      const bar = el("div", "vd-tool-actions");
      bar.append(
        button("Copy", "btn-ghost", () => transport.post({ type: "ui.copy", text: last })),
        button("Ask AI about this", "btn-ghost", () => {
          const fence = "```";
          const c = composerInput();
          c.value = `About this ${tool.name} result:\n${fence}${result.language ?? ""}\n${last.slice(0, 6000)}\n${fence}\n`;
          toggleTools(false);
          autoGrow();
          c.focus();
        })
      );
      if (state.capabilities.newFile) {
        bar.append(button("Open as file", "btn-ghost", () => transport.post({ type: "ui.newFile", text: last, languageId: result.language })));
      }
      out.append(bar);
    }
  }
  go.addEventListener("click", () => void run());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void run();
    }
  });
  if (generator) input.hidden = true;
  panel.append(input, actions, out);
  if (generator) void run();
}

function toggleToolkit(open?: boolean): void {
  state.toolkitOpen = open ?? !state.toolkitOpen;
  if (state.toolkitOpen) {
    state.toolkitView = "list";
    closeOtherDrawers("toolkit");
  }
  renderToolkit();
  syncDrawerLayout();
  if (state.toolkitOpen) (document.getElementById("vd-toolkit-search") as HTMLInputElement | null)?.focus();
}

function toolkitPanel(): HTMLElement {
  let panel = document.getElementById("vd-toolkit");
  if (!panel) {
    panel = el("section", "vd-toolkit");
    panel.id = "vd-toolkit";
    panel.setAttribute("aria-label", "Toolkit");
    messagesEl().before(panel);
  }
  return panel;
}

function renderToolkit(): void {
  if (!state.toolkitOpen) {
    document.getElementById("vd-toolkit")?.remove();
    return;
  }
  const panel = toolkitPanel();
  panel.textContent = "";
  const head = el("div", "vd-history-head");
  head.append(el("strong", undefined, state.toolkitView === "edit" ? (state.editingRecipeId ? "Edit recipe" : "New recipe") : state.toolkitView === "import" ? "Import recipes" : "Toolkit"));
  head.append(iconButton("close", "Close the Toolkit", () => toggleToolkit(false)));
  panel.append(head);
  if (state.toolkitView === "edit") {
    panel.append(renderRecipeEditor());
    return;
  }
  if (state.toolkitView === "import") {
    panel.append(renderRecipeImport());
    return;
  }

  const controls = el("div", "vd-toolkit-controls");
  const search = el("input", "vd-toolkit-search");
  search.id = "vd-toolkit-search";
  search.type = "search";
  search.placeholder = "Search recipes…";
  search.setAttribute("aria-label", "Search recipes");
  search.value = state.toolkitQuery;
  search.addEventListener("input", () => {
    state.toolkitQuery = search.value;
    renderToolkitList(list);
  });
  controls.append(search, roleSelect((role) => setRole(role)));
  panel.append(controls);

  const tools = el("div", "vd-toolkit-tools");
  tools.append(
    button("New recipe", "btn-ghost", () => openRecipeEditor(null)),
    button("Import", "btn-ghost", () => {
      state.toolkitView = "import";
      renderToolkit();
    }),
    button("Export mine", "btn-ghost", () => exportMyRecipes())
  );
  panel.append(tools);
  if (!canCompose()) {
    panel.append(
      el(
        "p",
        "vd-history-note",
        state.privateMode
          ? "Private Mode is on and no on-device model is ready - recipes run once one is."
          : "Sign in, or download a free on-device model, to run recipes."
      )
    );
  }
  const list = el("div", "vd-toolkit-list");
  panel.append(list);
  renderToolkitList(list);
}

function featureAvailable(card: FeatureCard): boolean {
  if (card.id === "code-tour") return state.capabilities.context.includes("file");
  return knowledgeOk();
}

function runFeature(card: FeatureCard): void {
  toggleToolkit(false);
  if (card.id === "code-tour") {
    runCommand("tour");
  } else {
    const input = composerInput();
    input.value = "/ask-team ";
    input.focus();
    setNotice("Type your question after /ask-team and press Enter.");
  }
}

function renderToolkitList(list: HTMLElement): void {
  list.textContent = "";
  const q = state.toolkitQuery.trim().toLowerCase();
  const role = currentRole();
  const features = FEATURE_CARDS.filter(
    (f) => featureAvailable(f) && (!q || `${f.name} ${f.description} ${f.slash}`.toLowerCase().includes(q.replace(/^\//, "")))
  );
  const recipes = allRecipes();
  const groups = groupRecipes(recipes, { role, query: state.toolkitQuery, capabilities: state.capabilities });
  const phases = new Set<SdlcPhase>([...groups.map((g) => g.phase), ...features.map((f) => f.phase)]);
  const ordered = PHASES.map((p) => p.id).filter((p) => phases.has(p));
  // Follow the role's phase order where groupRecipes decided it.
  ordered.sort((a, b) => {
    const ia = groups.findIndex((g) => g.phase === a);
    const ib = groups.findIndex((g) => g.phase === b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (ordered.length === 0) {
    list.append(
      el(
        "p",
        "vd-history-note",
        q ? `No recipes match "${state.toolkitQuery.trim()}".` : "No recipes are available in this host yet. Create your own with New recipe."
      )
    );
  }
  for (const phase of ordered) {
    const section = el("section", "vd-toolkit-group");
    section.append(el("h3", "vd-toolkit-phase", PHASES.find((p) => p.id === phase)?.label ?? phase));
    const grid = el("div", "vd-toolkit-grid");
    for (const f of features.filter((x) => x.phase === phase)) {
      grid.append(toolkitCard(f.name, f.description, [`/${f.slash}`, "built in"], () => runFeature(f)));
    }
    for (const r of groups.find((g) => g.phase === phase)?.recipes ?? []) {
      const meta: string[] = [];
      if (r.slash) meta.push(`/${r.slash}`);
      if (!r.localFriendly) meta.push("best on hosted");
      const kinds = recipeContextKinds(r, state.capabilities);
      if (kinds.length) meta.push(`uses ${kinds.map((k) => CONTEXT_KIND_LABELS[k].label.toLowerCase()).join(", ")}`);
      if (!r.builtIn) meta.push("mine");
      const card = toolkitCard(r.name, r.description, meta, () => pickRecipe(r));
      if (!r.builtIn) {
        const own = el("div", "vd-recipe-own");
        own.append(
          button("Edit", "vd-link-btn", () => openRecipeEditor(r.id)),
          button("Delete", "vd-link-btn", () => {
            userRecipes.delete(r.id);
            renderToolkit();
          })
        );
        card.append(own);
      }
      grid.append(card);
    }
    section.append(grid);
    list.append(section);
  }
  const hidden = recipes.filter((r) => !recipeAvailable(r, state.capabilities)).length;
  if (hidden > 0) {
    list.append(el("p", "vd-history-note", `${hidden} recipe${hidden === 1 ? " is" : "s are"} hidden - they need context this host can't supply.`));
  }
  const rejected = recipeSlash().rejected;
  if (rejected.length) {
    list.append(
      el(
        "p",
        "vd-history-note",
        `Slash aliases not used: ${rejected.map((r) => `/${r.alias} (${r.reason})`).join("; ")}`
      )
    );
  }
  if (!userRecipes.persistent) {
    list.append(el("p", "vd-history-note", "Storage is blocked in this window, so your own recipes last until it closes."));
  }
}

function toolkitCard(title: string, detail: string, meta: string[], run: () => void): HTMLElement {
  const wrap = el("div", "vd-recipe");
  const b = el("button", "vd-card vd-recipe-card");
  b.type = "button";
  b.append(el("span", "vd-card-title", title), el("span", "vd-card-detail", detail));
  if (meta.length) b.append(el("span", "vd-recipe-meta", meta.join(" · ")));
  b.addEventListener("click", run);
  wrap.append(b);
  return wrap;
}

/** A Toolkit card was picked: attach its context now (so the chips show what
 * will be sent), then either run it or wait for the person's input. */
function pickRecipe(recipe: Recipe): void {
  toggleToolkit(false);
  // Always listening: with nothing able to answer yet, the recipe's request
  // is held by send() and runs once sign-in or an on-device model is ready.
  if (busy()) {
    setNotice("Wait for the current answer to finish, or press Esc to stop it.");
    return;
  }
  const kinds = recipeContextKinds(recipe, state.capabilities).filter((k) => !state.attached.some((a) => a.kind === k));
  if (!recipeTakesInput(recipe)) {
    runRecipe(recipe, composerInput().value.trim());
    return;
  }
  state.armedRecipe = recipe;
  if (kinds.length) requestContext(kinds);
  renderComposer();
  composerInput().focus();
}

/** Run a recipe: gather its context kinds (only those the host has), fill
 * {{input}}, send - hosted or on-device by the normal route. */
function runRecipe(recipe: Recipe, input: string): void {
  state.armedRecipe = null;
  const kinds = recipeContextKinds(recipe, state.capabilities);
  const wanted = kinds.filter((k) => !state.attached.some((a) => a.kind === k));
  const proceed = () => {
    if (recipe.requiresContext && !state.attached.some((a) => kinds.includes(a.kind))) {
      setNotice(
        notice?.text ?? `"${recipe.name}" needs ${kinds.map((k) => CONTEXT_KIND_LABELS[k].label.toLowerCase()).join(" or ")}, and none was available.`,
        "error"
      );
      renderComposer();
      return;
    }
    const note =
      !recipe.localFriendly && usingLocal()
        ? `"${recipe.name}" works best on a larger hosted model - the on-device answer may be rough.`
        : undefined;
    send({
      display: `${recipe.name}${input ? `: ${input}` : ""}`,
      instruction: fillRecipePrompt(recipe, input),
      command: `recipe:${recipe.id}`,
      note,
    });
  };
  if (wanted.length === 0) {
    proceed();
    return;
  }
  state.gathering = true;
  renderComposer();
  requestContext(wanted, (ok) => {
    state.gathering = false;
    renderComposer();
    if (ok) proceed();
  });
}

// --- My recipes: editor, import, export ----------------------------------------------------

function openRecipeEditor(id: string | null): void {
  state.toolkitOpen = true;
  state.toolkitView = "edit";
  state.editingRecipeId = id;
  closeOtherDrawers("toolkit");
  renderToolkit();
  syncDrawerLayout();
  (document.getElementById("vd-recipe-name") as HTMLInputElement | null)?.focus();
}

function labelled(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el("label", "vd-form-row");
  row.append(el("span", "vd-form-label", labelText), control);
  if (hint) row.append(el("span", "vd-form-hint", hint));
  return row;
}

function recipeAliasesExcept(id: string | null): Set<string> {
  return new Set(
    allRecipes()
      .filter((r) => r.id !== id && r.slash)
      .map((r) => r.slash as string)
  );
}

function renderRecipeEditor(): HTMLElement {
  const existing = state.editingRecipeId ? userRecipes.get(state.editingRecipeId) : undefined;
  const form = el("form", "vd-form");
  form.noValidate = true;

  const name = el("input");
  name.id = "vd-recipe-name";
  name.maxLength = 80;
  name.value = existing?.name ?? "";
  const description = el("input");
  description.maxLength = 300;
  description.value = existing?.description ?? "";
  const prompt = el("textarea", "vd-form-prompt");
  prompt.rows = 6;
  prompt.maxLength = 8000;
  prompt.value = existing?.prompt ?? "";
  prompt.placeholder = "e.g. Turn this into a release note for customers: {{input}}";
  const phase = el("select");
  for (const p of PHASES) {
    const o = el("option", undefined, p.label);
    o.value = p.id;
    phase.append(o);
  }
  phase.value = existing?.phase ?? "build";
  const role = el("select");
  for (const r of ROLES) {
    const o = el("option", undefined, r.label);
    o.value = r.id;
    role.append(o);
  }
  role.value = existing?.roles[0] ?? currentRole();
  const slash = el("input");
  slash.maxLength = 24;
  slash.placeholder = "optional, e.g. relnote";
  slash.value = existing?.slash ?? "";
  const outputKind = el("select");
  for (const [value, text] of [
    ["markdown", "Text / markdown"],
    ["code", "Code"],
    ["csv", "CSV"],
    ["json", "JSON"],
    ["mermaid", "Mermaid diagram"],
  ]) {
    const o = el("option", undefined, text);
    o.value = value;
    outputKind.append(o);
  }
  outputKind.value = existing?.output?.kind ?? "markdown";
  const languageId = el("input");
  languageId.maxLength = 40;
  languageId.placeholder = "optional, e.g. typescript";
  languageId.value = existing?.output?.languageId ?? "";

  const checkbox = (text: string, checked: boolean): [HTMLLabelElement, HTMLInputElement] => {
    const row = el("label", "vd-form-check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = checked;
    row.append(box, el("span", undefined, text));
    return [row, box];
  };

  const contextBoxes = new Map<string, HTMLInputElement>();
  const contextSet = el("fieldset", "vd-form-fieldset");
  contextSet.append(el("legend", undefined, "Attach automatically"));
  for (const kind of ALL_CONTEXT_KINDS) {
    const here = state.capabilities.context.includes(kind);
    const [row, box] = checkbox(`${CONTEXT_KIND_LABELS[kind].label}${here ? "" : " (not in this host)"}`, existing?.context.includes(kind) ?? false);
    contextBoxes.set(kind, box);
    contextSet.append(row);
  }
  const [requiresRow, requires] = checkbox("Needs one of these to be useful (hide it where none can be attached)", existing?.requiresContext === true);
  const [newFileRow, offerNewFile] = checkbox("Offer \"Open as new file\" on the answer", existing?.output?.offerNewFile === true);
  const [localRow, localFriendly] = checkbox("Works on a small on-device model", existing?.localFriendly ?? true);

  const error = el("p", "vd-form-error");
  error.setAttribute("role", "alert");
  error.hidden = true;

  form.append(
    labelled("Name", name),
    labelled("What it does", description, "One sentence, shown on the card."),
    labelled("Prompt", prompt, "Write {{input}} where the text you type when running it should go."),
    labelled("Phase", phase),
    labelled("Mostly for", role),
    contextSet,
    requiresRow,
    labelled("Slash alias", slash, "Run it by typing /alias in the chat box."),
    labelled("Answer is", outputKind),
    labelled("Language for new files", languageId),
    newFileRow,
    localRow,
    error
  );
  const actions = el("div", "vd-form-actions");
  const save = el("button", "btn-primary", existing ? "Save changes" : "Create recipe");
  save.type = "submit";
  actions.append(
    save,
    button("Cancel", "btn-ghost", () => {
      state.toolkitView = "list";
      renderToolkit();
    })
  );
  form.append(actions);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const taken = new Set([...BUILT_IN_RECIPES.map((r) => r.id), ...userRecipes.list().map((r) => r.id)]);
    const id = existing?.id ?? newRecipeId(name.value || "recipe", taken);
    const roles = [role.value, ...(existing?.roles.slice(1).filter((r) => r !== role.value) ?? [])];
    const raw: Record<string, unknown> = {
      id,
      name: name.value,
      description: description.value.trim() ? description.value : name.value,
      phase: phase.value,
      roles,
      context: ALL_CONTEXT_KINDS.filter((k) => contextBoxes.get(k)?.checked),
      prompt: prompt.value,
      localFriendly: localFriendly.checked,
      builtIn: false,
    };
    if (requires.checked) raw.requiresContext = true;
    const alias = slash.value.trim().replace(/^\//, "").toLowerCase();
    if (alias) raw.slash = alias;
    const output: Record<string, unknown> = { kind: outputKind.value };
    if (languageId.value.trim()) output.languageId = languageId.value.trim();
    if (offerNewFile.checked) output.offerNewFile = true;
    raw.output = output;
    const checked = validateRecipe(raw, { builtInCommands: BUILT_IN_COMMAND_NAMES });
    let problem = checked.ok ? null : checked.error;
    if (!problem && alias) problem = slashAliasProblem(alias, BUILT_IN_COMMAND_NAMES, recipeAliasesExcept(id));
    if (problem || !checked.ok) {
      error.textContent = problem ?? "That recipe is not valid.";
      error.hidden = false;
      return;
    }
    userRecipes.upsert(checked.recipe);
    state.toolkitView = "list";
    state.editingRecipeId = null;
    renderToolkit();
  });
  return form;
}

function renderRecipeImport(): HTMLElement {
  const box = el("div", "vd-form");
  box.append(
    el(
      "p",
      "vd-history-note",
      "Paste recipe JSON (from Export, or a list of recipes). It is checked strictly: anything that is not exactly a recipe is refused, and nothing is imported unless every recipe is valid."
    )
  );
  const text = el("textarea", "vd-form-prompt");
  text.rows = 10;
  text.setAttribute("aria-label", "Recipe JSON");
  text.spellcheck = false;
  box.append(text);
  const result = el("p", "vd-form-error");
  result.setAttribute("role", "alert");
  result.hidden = true;
  box.append(result);
  const actions = el("div", "vd-form-actions");
  actions.append(
    button("Import", "btn-primary", () => {
      const parsed = parseRecipeImport(text.value, {
        builtInCommands: BUILT_IN_COMMAND_NAMES,
        builtInIds: new Set(BUILT_IN_RECIPES.map((r) => r.id)),
      });
      if (!parsed.ok) {
        result.className = "vd-form-error";
        result.textContent = parsed.error;
        result.hidden = false;
        return;
      }
      const incomingIds = new Set(parsed.recipes.map((r) => r.id));
      const otherAliases = new Set(
        allRecipes()
          .filter((r) => !incomingIds.has(r.id) && r.slash)
          .map((r) => r.slash as string)
      );
      const clash = parsed.recipes.find((r) => r.slash && otherAliases.has(r.slash));
      if (clash) {
        result.className = "vd-form-error";
        result.textContent = `"${clash.name}": /${clash.slash} is already used by another recipe. Nothing was imported.`;
        result.hidden = false;
        return;
      }
      const { added, replaced } = userRecipes.importAll(parsed.recipes);
      state.toolkitView = "list";
      renderToolkit();
      setNotice(`Imported ${added} recipe${added === 1 ? "" : "s"}${replaced ? `, replaced ${replaced}` : ""}.`);
    }),
    button("Cancel", "btn-ghost", () => {
      state.toolkitView = "list";
      renderToolkit();
    })
  );
  box.append(actions);
  return box;
}

function exportMyRecipes(): void {
  const mine = userRecipes.list();
  if (mine.length === 0) {
    setNotice("You have no recipes of your own to export yet - create one with New recipe.");
    return;
  }
  const json = exportRecipes(mine);
  if (state.capabilities.newFile) {
    transport.post({ type: "ui.newFile", text: json, languageId: "json" });
    setNotice(`Opened ${mine.length} recipe${mine.length === 1 ? "" : "s"} as JSON in a new tab - save it anywhere to share.`);
  } else {
    transport.post({ type: "ui.copy", text: json });
    setNotice(`Copied ${mine.length} recipe${mine.length === 1 ? "" : "s"} as JSON.`);
  }
}

// --- Ask the team (team knowledge) -----------------------------------------------------------

interface PendingKnowledge {
  question: string;
  card: HTMLElement;
  timer: number;
}

const pendingKnowledge = new Map<string, PendingKnowledge>();
const KNOWLEDGE_TIMEOUT_MS = 20_000;
const KNOWLEDGE_TOP_K = 8;

function cancelKnowledgeSearches(): void {
  for (const [reqId, p] of pendingKnowledge) {
    window.clearTimeout(p.timer);
    p.card.textContent = describeKnowledgeFailure("private");
    pendingKnowledge.delete(reqId);
  }
}

function startAskTeam(question: string): void {
  if (!knowledgeOk()) {
    setNotice(
      state.privateMode
        ? describeKnowledgeFailure("private")
        : !state.auth.signedIn
          ? describeKnowledgeFailure("signed-out")
          : "Team knowledge isn't available in this host or with an API-key sign-in.",
      "error"
    );
    return;
  }
  if (!question) {
    setNotice("Type your question after /ask-team - for example: /ask-team how do we rotate API keys?");
    composerInput().value = "/ask-team ";
    composerInput().focus();
    return;
  }
  composerInput().value = "";
  setNotice(null);
  const reqId = nextReqId("kb");
  const card = appendSystem(`Searching your team's knowledge for "${question}"…`);
  card.parentElement?.classList.add("vd-kb");
  const timer = window.setTimeout(() => {
    if (!pendingKnowledge.has(reqId)) return;
    pendingKnowledge.delete(reqId);
    card.parentElement?.classList.add("msg-error");
    card.textContent = "The knowledge search did not answer in time. Try again.";
  }, KNOWLEDGE_TIMEOUT_MS);
  pendingKnowledge.set(reqId, { question, card, timer });
  transport.post({ type: "knowledge.search", reqId, query: question, topK: KNOWLEDGE_TOP_K });
}

function onKnowledgeResult(message: Extract<HostToWebview, { type: "knowledge.result" }>): void {
  const pending = pendingKnowledge.get(message.reqId);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  pendingKnowledge.delete(message.reqId);
  const { card, question } = pending;
  card.textContent = "";
  if (!message.ok) {
    card.parentElement?.classList.add("msg-error");
    card.textContent = describeKnowledgeFailure(message.reason);
    return;
  }
  const hits: KnowledgeHit[] = (Array.isArray(message.hits) ? message.hits : []).filter(isKnowledgeHit).slice(0, KNOWLEDGE_TOP_K);
  if (hits.length === 0) {
    card.append(el("div", "vd-kb-title", `No matches for "${question}" in your team's knowledge.`));
    card.append(el("p", "vd-kb-note", "Try different words, or ask without sources."));
    card.append(
      button("Ask without sources", "btn-ghost", () => {
        if (busy()) {
          setNotice("Wait for the current answer to finish, or press Esc to stop it.");
          return;
        }
        card.querySelectorAll("button").forEach((b) => (b.disabled = true));
        send({ display: question, instruction: question });
      })
    );
    return;
  }
  card.append(el("div", "vd-kb-title", `${hits.length} source${hits.length === 1 ? "" : "s"} for "${question}"`));
  card.append(el("p", "vd-kb-note", "Pick the sources to attach. The answer cites them as [1], [2]."));
  const list = el("ol", "vd-kb-list");
  const boxes: Array<[HTMLInputElement, KnowledgeHit]> = [];
  hits.forEach((hit, i) => {
    const li = el("li", "vd-kb-hit");
    const label = el("label", "vd-kb-pick");
    const box = el("input");
    box.type = "checkbox";
    box.checked = i < 3;
    label.append(box, el("span", "vd-kb-source", hitSource(hit, i)), el("span", "vd-kb-close", closenessLabel(hit.distance)));
    const snippet = hit.content.replace(/\s+/g, " ").trim();
    li.append(label, el("p", "vd-kb-snippet", snippet.length > 280 ? `${snippet.slice(0, 279)}…` : snippet));
    boxes.push([box, hit]);
    list.append(li);
  });
  card.append(list);
  const actions = el("div", "vd-kb-actions");
  const answer = button("Answer with selected sources", "btn-primary", () => {
    const chosen = boxes.filter(([b]) => b.checked).map(([, h]) => h);
    if (chosen.length === 0) {
      setNotice("Pick at least one source, or ask without sources.", "error");
      return;
    }
    if (busy()) {
      setNotice("Wait for the current answer to finish, or press Esc to stop it.");
      return;
    }
    if (!canCompose()) {
      setNotice("Nothing can answer right now - sign in or load an on-device model.", "error");
      return;
    }
    actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    boxes.forEach(([b]) => (b.disabled = true));
    send({
      display: `Ask the team: ${question}`,
      instruction: buildAskTeamPrompt(question, chosen),
      command: "ask-team",
      labels: chosen.map((h) => `[${hits.indexOf(h) + 1}] ${hitSource(h, hits.indexOf(h))}`),
    });
  });
  actions.append(
    answer,
    button("Ask without sources", "btn-ghost", () => {
      if (busy()) return;
      actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
      send({ display: question, instruction: question });
    })
  );
  card.append(actions);
  scrollToBottom();
}

// --- context attachments --------------------------------------------------------------------

interface PendingContext {
  kinds: ContextKind[];
  timer: number;
  onDone?: (ok: boolean) => void;
}

const pendingContext = new Map<string, PendingContext>();
const CONTEXT_TIMEOUT_MS = 15_000;

let notice: { text: string; tone: "info" | "error" } | null = null;

function setNotice(text: string | null, tone: "info" | "error" = "info"): void {
  notice = text ? { text, tone } : null;
  renderContextBar();
}

function requestContext(kinds: ContextKind[], onDone?: (ok: boolean) => void): void {
  const supported = kinds.filter((k) => state.capabilities.context.includes(k));
  if (supported.length === 0) {
    onDone?.(true);
    return;
  }
  const reqId = nextReqId("ctx");
  const timer = window.setTimeout(() => {
    const pending = pendingContext.get(reqId);
    if (!pending) return;
    pendingContext.delete(reqId);
    setNotice(`The ${state.platform === "chrome" ? "browser" : "editor"} did not return the requested context in time. Try again.`, "error");
    pending.onDone?.(false);
    renderContextBar();
  }, CONTEXT_TIMEOUT_MS);
  pendingContext.set(reqId, { kinds: supported, timer, onDone });
  transport.post({ type: "context.request", reqId, kinds: supported });
  renderContextBar();
}

function onContextResult(message: Extract<HostToWebview, { type: "context.result" }>): void {
  const pending = pendingContext.get(message.reqId);
  if (!pending) return; // late answer after a timeout - ignore
  window.clearTimeout(pending.timer);
  pendingContext.delete(message.reqId);
  for (const item of message.items ?? []) {
    if (!item || typeof item.text !== "string" || !pending.kinds.includes(item.kind)) continue;
    // One chip per kind+label: re-attaching refreshes it.
    state.attached = state.attached.filter((a) => !(a.kind === item.kind && a.label === item.label));
    state.attached.push(item);
  }
  const missing = (message.missing ?? []).filter((m) => m && typeof m.reason === "string");
  if (missing.length) {
    setNotice(
      missing.map((m) => `Couldn't attach ${CONTEXT_KIND_LABELS[m.kind]?.label.toLowerCase() ?? m.kind}: ${m.reason}`).join(" · "),
      "error"
    );
  } else {
    setNotice(null);
  }
  pending.onDone?.(true);
  renderContextBar();
}

let contextMenuOpen = false;

function renderContextBar(): void {
  const bar = document.getElementById("vd-context-bar");
  if (!bar) return;
  bar.textContent = "";
  const kinds = state.capabilities.context;
  if (kinds.length) {
    const attach = el("button", "vd-attach");
    attach.type = "button";
    attach.id = "vd-attach";
    attach.setAttribute("aria-haspopup", "menu");
    attach.setAttribute("aria-expanded", String(contextMenuOpen));
    attach.title = "Attach context to your next message";
    attach.append(icon("clip"), el("span", undefined, "Attach"));
    attach.disabled = busy();
    attach.addEventListener("click", () => {
      contextMenuOpen = !contextMenuOpen;
      renderContextBar();
      if (contextMenuOpen) (document.querySelector(".vd-menu button") as HTMLButtonElement | null)?.focus();
    });
    bar.append(attach);
    if (contextMenuOpen) {
      const menu = el("div", "vd-menu");
      menu.setAttribute("role", "menu");
      for (const kind of kinds) {
        const item = el("button", "vd-menu-item");
        item.type = "button";
        item.setAttribute("role", "menuitem");
        const hint =
          kind === "selection" && state.platform === "chrome"
            ? "Text you have selected on the page"
            : CONTEXT_KIND_LABELS[kind].hint;
        item.append(el("span", "vd-menu-title", CONTEXT_KIND_LABELS[kind].label), el("span", "vd-menu-hint", hint));
        item.addEventListener("click", () => {
          contextMenuOpen = false;
          requestContext([kind]);
          composerInput().focus();
        });
        menu.append(item);
      }
      menu.addEventListener("keydown", (event) => {
        const items = Array.from(menu.querySelectorAll("button"));
        const idx = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") {
          event.preventDefault();
          contextMenuOpen = false;
          renderContextBar();
          document.getElementById("vd-attach")?.focus();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          items[(idx + 1) % items.length]?.focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          items[(idx - 1 + items.length) % items.length]?.focus();
        }
      });
      bar.append(menu);
    }
  }
  if (canCompose()) bar.append(renderModeChips());
  if (state.armedRecipe) {
    const armed = state.armedRecipe;
    const chip = el("span", "vd-chip vd-chip-recipe");
    chip.title = armed.description;
    chip.append(icon("grid"), el("span", "vd-chip-label", `Recipe: ${armed.name}`));
    chip.append(
      iconButton("close", `Cancel ${armed.name}`, () => {
        state.armedRecipe = null;
        renderComposer();
        composerInput().focus();
      }, "vd-chip-remove")
    );
    bar.append(chip);
  }
  for (const item of state.attached) {
    const chip = el("span", "vd-chip");
    chip.title = `${CONTEXT_KIND_LABELS[item.kind]?.label ?? item.kind} · ${item.text.length.toLocaleString()} characters${item.truncated ? " (truncated by the host)" : ""}`;
    chip.append(icon("clip"), el("span", "vd-chip-label", item.label));
    if (item.truncated) chip.append(el("span", "vd-chip-badge", "truncated"));
    const remove = iconButton("close", `Remove ${item.label}`, () => {
      state.attached = state.attached.filter((a) => a !== item);
      renderContextBar();
      composerInput().focus();
    }, "vd-chip-remove");
    chip.append(remove);
    bar.append(chip);
  }
  if (pendingContext.size > 0) bar.append(el("span", "vd-pending", "Gathering context…"));
  if (notice) {
    const n = el("span", `vd-notice${notice.tone === "error" ? " vd-notice-error" : ""}`, notice.text);
    n.setAttribute("role", "status");
    bar.append(n);
  }
  bar.hidden = bar.childElementCount === 0;
}

/** Rubber Duck and Second Opinion toggles, beside Attach. */
function renderModeChips(): HTMLElement {
  const row = el("span", "vd-modes");
  const duck = el("button", `vd-mode${state.duck ? " vd-mode-on" : ""}`, "Rubber duck");
  duck.type = "button";
  duck.setAttribute("aria-pressed", String(state.duck));
  duck.title = state.duck
    ? "Rubber duck is on: the assistant asks one question at a time. Say \"just tell me\" for the answer. Click to turn off."
    : "Rubber duck: the assistant helps you find the answer yourself, one question at a time.";
  duck.addEventListener("click", () => {
    state.duck = !state.duck;
    renderComposer();
    composerInput().focus();
  });
  row.append(duck);
  if (secondOpinionOk()) {
    const cmp = el("button", `vd-mode${state.compareNext ? " vd-mode-on" : ""}`);
    cmp.type = "button";
    cmp.append(icon("columns"), el("span", undefined, "Second opinion"));
    cmp.setAttribute("aria-pressed", String(state.compareNext));
    cmp.title = state.compareNext
      ? "Second opinion is on: each message runs on this machine AND on your agent, side by side. Click to turn off."
      : "Run each message on this machine and on your agent, side by side.";
    cmp.addEventListener("click", () => {
      state.compareNext = !state.compareNext;
      renderComposer();
      composerInput().focus();
    });
    row.append(cmp);
  } else if (state.compareNext) {
    state.compareNext = false;
  }
  return row;
}

function renderHint(): void {
  const hint = document.getElementById("vd-hint");
  if (!hint) return;
  hint.hidden = false;
  if (!canCompose()) {
    hint.textContent = "Always listening · Enter to send · / for commands";
    return;
  }
  hint.textContent = state.streamingReqId
    ? "Esc to stop"
    : `${state.privateMode ? "Private Mode · on-device" : usingLocal() ? "On-device" : "Hosted"}${state.duck ? " · Rubber duck" : ""}${state.compareNext && secondOpinionOk() ? " · Second opinion" : ""} · Enter to send · Shift+Enter for a new line · / for commands`;
}

// --- slash-command popup ---------------------------------------------------------------------

let slashMatches: SlashCommand[] = [];
let slashIndex = 0;

function renderSlash(): void {
  const popup = document.getElementById("vd-slash");
  if (!popup) return;
  const input = composerInput();
  slashMatches = canCompose() ? matchCommands(input.value, commandsHere()) : [];
  popup.textContent = "";
  if (slashMatches.length === 0) {
    popup.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    return;
  }
  slashIndex = Math.min(slashIndex, slashMatches.length - 1);
  popup.hidden = false;
  input.setAttribute("aria-expanded", "true");
  slashMatches.forEach((cmd, idx) => {
    const option = el("div", `vd-slash-item${idx === slashIndex ? " vd-slash-active" : ""}`);
    option.id = `vd-slash-${cmd.name}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(idx === slashIndex));
    option.append(el("span", "vd-slash-name", `/${cmd.name}`), el("span", "vd-slash-desc", cmd.description));
    option.addEventListener("mousedown", (event) => {
      event.preventDefault(); // keep focus in the textarea
      acceptSlash(idx, true);
    });
    popup.append(option);
    if (idx === slashIndex) input.setAttribute("aria-activedescendant", option.id);
  });
  popup.append(el("div", "vd-slash-foot", "Enter to run · Tab to add a note · Esc to close"));
}

function closeSlash(): void {
  slashMatches = [];
  const popup = document.getElementById("vd-slash");
  if (popup) popup.hidden = true;
  composerInput().setAttribute("aria-expanded", "false");
}

function acceptSlash(idx: number, run: boolean): void {
  const cmd = slashMatches[idx];
  if (!cmd) return;
  const input = composerInput();
  input.value = `/${cmd.name}${run ? "" : " "}`;
  closeSlash();
  if (run) submit();
  else input.focus();
}

/** Used by welcome cards: run a slash command as if typed. */
function runCommand(name: string): void {
  const input = composerInput();
  input.value = `/${name}`;
  submit();
}

// --- sending -----------------------------------------------------------------------------------

/** On-device conversation memory for the current local thread (full prompts,
 * including attachments, so follow-ups keep context; the engine windows it). */
const localTurns: Array<{ role: "user" | "assistant"; content: string }> = [];
const LOCAL_HISTORY_MAX_TURNS = 12;

const LOCAL_SYSTEM_PROMPT =
  "You are VegaDuta, a helpful assistant running entirely on the user's own device - " +
  "no data leaves this machine. Answer directly and completely; use fenced code blocks " +
  "for code; say plainly when you are not sure instead of guessing.";

interface OutgoingRequest {
  display: string;
  instruction: string;
  items: ContextItem[];
  command?: string;
  threadId: string;
  /** Rubber Duck was on for this turn. */
  duck?: boolean;
  /** Code Tour: where the stops point and how long the file is. */
  tour?: { path?: string; lineCount: number };
  /** Chip labels beyond the attachments (Ask the team's sources). */
  labels?: string[];
}

interface SendRequest {
  display: string;
  instruction: string;
  command?: string;
  tour?: OutgoingRequest["tour"];
  labels?: string[];
  /** A notice shown under the user's message (e.g. a recipe that works best
   * on a hosted model is running on-device). */
  note?: string;
}

let lastRequest: OutgoingRequest | null = null;

/** Composer submit: slash commands, context gathering, then send. */
function submit(): void {
  const input = composerInput();
  const raw = input.value.trim();
  if (!raw && !state.armedRecipe) return;
  if (busy()) {
    setNotice("Wait for the current answer to finish, or press Esc to stop it.");
    return;
  }
  closeSlash();
  const commands = commandsHere();
  const slash = raw.startsWith("/") ? parseSlash(raw, commands) : null;

  if (!slash) {
    // A built-in command that exists but is not available right now (e.g.
    // /ask-team in Private Mode) must say why - never go out as plain text.
    const typed = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(raw);
    const name = typed?.[1].toLowerCase();
    if (name && BUILT_IN_COMMAND_NAMES.has(name)) {
      if (name === "ask-team") {
        startAskTeam((typed?.[2] ?? "").trim());
      } else {
        setNotice(`/${name} isn't available here right now. Type /help to see what is.`, "error");
      }
      return;
    }
    if (typed && typed[2] === undefined) {
      setNotice(`Unknown command ${raw}. Type /help to see what's available here.`, "error");
      return;
    }
  }

  if (slash && slash.command.action !== "prompt") {
    input.value = "";
    switch (slash.command.action) {
      case "new":
        newChat();
        break;
      case "clear":
        if (thread) history.delete(thread.id);
        newChat();
        break;
      case "models":
        void toggleModels(true);
        break;
      case "help":
        showHelp();
        break;
      case "toolkit":
        toggleToolkit(true);
        break;
      case "tour":
        runTour(raw, slash.arg);
        break;
      case "askTeam":
        startAskTeam(slash.arg);
        break;
    }
    return;
  }

  if (!slash && state.armedRecipe) {
    runRecipe(state.armedRecipe, raw);
    return;
  }

  if (!slash) {
    send({ display: raw, instruction: raw });
    return;
  }

  const cmd = slash.command;
  if (cmd.recipeId) {
    const recipe = findRecipe(cmd.recipeId);
    if (recipe) {
      input.value = "";
      runRecipe(recipe, slash.arg);
      return;
    }
  }
  const wanted = requestableContext(cmd, state.capabilities).filter((k) => !state.attached.some((a) => a.kind === k));
  const proceed = () => {
    const kinds = supportedContext(cmd, state.capabilities);
    if (cmd.requiresContext && !state.attached.some((a) => kinds.includes(a.kind))) {
      setNotice(
        notice?.text ?? `/${cmd.name} needs ${kinds.map((k) => CONTEXT_KIND_LABELS[k].label.toLowerCase()).join(" or ")}, and none was available.`,
        "error"
      );
      return;
    }
    let instruction = commandInstruction(cmd, slash.arg);
    // Commit style: with the recent log attached, match the team's conventions.
    if (cmd.name === "commit") instruction = commitInstruction(instruction, state.attached);
    send({ display: raw, instruction, command: cmd.name });
  };
  if (wanted.length === 0) {
    proceed();
    return;
  }
  state.gathering = true;
  renderComposer();
  requestContext(wanted, (ok) => {
    state.gathering = false;
    renderComposer();
    if (ok) proceed();
  });
}

function composeBlockedText(): string {
  if (state.privateMode) {
    return state.hostLocalEngine
      ? "Private Mode is on and no on-device model is ready, so nothing can answer. Open the on-device models to download one - nothing is sent to a hosted agent instead."
      : "Private Mode is on and this host has no on-device engine, so nothing can answer. Nothing is sent to a hosted agent instead.";
  }
  return state.hostLocalEngine ? "Sign in, or download a free on-device model, to start chatting." : "Sign in to start chatting.";
}

/** /tour: attach the current file WITH line numbers, ask for stops. */
function runTour(raw: string, arg: string): void {
  const proceed = () => {
    const file = state.attached.find((a) => a.kind === "file");
    if (!file) {
      setNotice(notice?.text ?? "Code Tour needs the current file, and none was available. Open a file and try again.", "error");
      return;
    }
    const lineCount = countLines(file.text);
    const numbered: ContextItem = { ...file, text: numberLines(file.text) };
    state.attached = state.attached.map((a) => (a === file ? numbered : a));
    send({
      display: raw,
      instruction: arg ? `${TOUR_INSTRUCTION}\n\nMy note: ${arg}` : TOUR_INSTRUCTION,
      command: "tour",
      tour: { path: file.label, lineCount },
    });
  };
  // Always fetch the file fresh: a tour of a stale attachment would point at
  // the wrong lines.
  state.attached = state.attached.filter((a) => a.kind !== "file");
  state.gathering = true;
  renderComposer();
  requestContext(["file"], (ok) => {
    state.gathering = false;
    renderComposer();
    if (ok) proceed();
  });
}

function send(req: SendRequest): void {
  const route = routeNow();
  if (route !== "local" && route !== "hosted") {
    parkRequest(req);
    return;
  }
  const local = route === "local";
  if (!local && !state.selectedAgentId) {
    setNotice("No agent is available on your account yet. Create one in VegaDūta, or use an on-device model.", "error");
    return;
  }
  const compare = state.compareNext && secondOpinionOk();
  const t = ensureThread(local ? "local" : "hosted");
  const items = [...state.attached];
  const outgoing: OutgoingRequest = {
    display: req.display,
    instruction: req.instruction,
    command: req.command,
    items,
    threadId: t.id,
    ...(state.duck ? { duck: true } : {}),
    ...(req.tour ? { tour: req.tour } : {}),
    ...(req.labels?.length ? { labels: req.labels } : {}),
  };
  composerInput().value = "";
  state.attached = [];
  state.armedRecipe = null;
  setNotice(null);
  const labels = [...items.map((i) => i.label), ...(req.labels ?? [])];
  const userItem = appendUser(req.display, labels);
  history.append(t.id, { role: "user", text: req.display, context: labels, command: req.command }, titleFrom(req.display));
  if (req.note) appendSystem(req.note);
  lastRequest = outgoing;
  scrollToBottom(true);
  flyEmblem(userItem);
  if (compare) {
    void runCompare(outgoing, true);
  } else {
    dispatch(outgoing);
  }
  addSecondOpinionButton(userItem, outgoing);
}

function dispatch(req: OutgoingRequest): void {
  clearRetryButtons();
  const route = routeNow();
  if (route === "local") {
    void sendLocal(req);
  } else if (route === "hosted") {
    sendHosted(req);
  } else {
    // Never a silent failure and never a hosted fallback in Private Mode.
    appendSystem(composeBlockedText(), "error");
  }
}

const hostedViews = new Map<string, { view: AssistantView; req: OutgoingRequest; compareId?: string }>();

/** The hosted message text: attachments folded in, and the Rubber Duck rule
 * carried with the message (hosted agents have their own system prompt). */
function hostedMessage(req: OutgoingRequest): string {
  const instruction = req.duck ? duckMessage(req.instruction, wantsTheAnswer(req.display)) : req.instruction;
  return buildPrompt(instruction, req.items);
}

function localSystemPrompt(req: OutgoingRequest): string {
  if (!req.duck) return LOCAL_SYSTEM_PROMPT;
  return `${LOCAL_SYSTEM_PROMPT}\n\n${wantsTheAnswer(req.display) ? DUCK_ANSWER_INSTRUCTION : DUCK_INSTRUCTION}`;
}

function sendHosted(req: OutgoingRequest): void {
  const agentId = state.selectedAgentId;
  if (!agentId || !thread) return;
  const reqId = nextReqId("chat");
  state.streamingReqId = reqId;
  const view = createAssistantView();
  hostedViews.set(reqId, { view, req });
  transport.post({
    type: "chat.send",
    reqId,
    agentId,
    message: hostedMessage(req),
    sessionId: thread.sessionId ?? null,
  });
  setStreamingUi(true);
}

function activeContextWindow(): number | undefined {
  const id = state.engine.modelId;
  const m = id ? state.models?.models.find((x) => x.id === id) : undefined;
  return m?.contextWindowSize ?? undefined;
}

const localReqs = new Set<string>();

async function sendLocal(req: OutgoingRequest): Promise<void> {
  if (!engineHost) {
    appendSystem("The on-device engine is not running in this host.", "error");
    return;
  }
  const systemPrompt = localSystemPrompt(req);
  const fit = fitContextForLocal(req.instruction, req.items, systemPrompt, activeContextWindow());
  if (!fit.fits) {
    const view = createAssistantView();
    const msg =
      "This message is too long for the on-device model's context window. Shorten it, or switch to Hosted for long inputs.";
    view.showError(msg);
    view.finish({ retryable: false });
    if (thread) history.append(thread.id, { role: "assistant", text: msg, error: true });
    return;
  }
  if (fit.notes.length) appendSystem(fit.notes.join(" "));
  const prompt = buildPrompt(req.instruction, fit.items);

  const reqId = nextReqId("local");
  state.streamingReqId = reqId;
  localReqs.add(reqId);
  const view = createAssistantView();
  setStreamingUi(true);
  const historyTurns = localTurns.slice(-LOCAL_HISTORY_MAX_TURNS * 2);
  let streamed = "";
  const result = await engineHost.run(
    reqId,
    "chat",
    { text: prompt, systemPrompt, history: historyTurns },
    (delta) => {
      streamed += delta;
      view.setText(streamed, false);
    }
  );
  localReqs.delete(reqId);
  const threadId = req.threadId;
  if (result.ok && result.text) {
    view.setText(result.text, true);
    localTurns.push({ role: "user", content: prompt }, { role: "assistant", content: result.text });
    history.append(threadId, { role: "assistant", text: result.text, command: req.command });
    view.finish({ command: req.command, retryable: true, req });
  } else if (result.reason === "aborted") {
    if (streamed) {
      view.setText(`${streamed}`, true);
      history.append(threadId, { role: "assistant", text: streamed, command: req.command });
    }
    view.showError(streamed ? "Stopped." : "Stopped before any answer.");
    view.finish({ command: req.command, retryable: true, req });
  } else {
    const msg = `On-device answer failed: ${describeLocalFailure(result.reason)}`;
    view.showError(msg);
    history.append(threadId, { role: "assistant", text: msg, error: true });
    view.finish({ retryable: true });
  }
  finishStream(reqId);
}

function describeLocalFailure(reason?: string): string {
  switch (reason) {
    case "unavailable":
      return "no model is ready - download one from the on-device chip.";
    case "context-window-exceeded":
      return "the conversation is too long for this model's context window. Start a new chat (/new).";
    case "generation-timeout":
    case "turn-ceiling-exceeded":
      return "the model took too long. Try a shorter question or a smaller model.";
    case "engine-failed":
      return "the model could not load (often GPU memory). Try a smaller model.";
    case "empty-reply":
      return "the model returned nothing.";
    default:
      return reason ?? "unknown error";
  }
}

function setStreamingUi(streaming: boolean): void {
  const send = $("composer-send") as HTMLButtonElement;
  setSendLabel(send, streaming ? "Stop" : "Send");
  send.classList.toggle("btn-stop", streaming);
  send.title = streaming ? "Stop generating (Esc)" : "Send (Enter)";
  renderComposer();
  if (state.historyOpen) renderHistory();
}

// --- Second Opinion ---------------------------------------------------------------

interface CompareRun {
  hostedReqId: string;
  localReqId: string;
  remaining: number;
  /** Composer-option compares are saved to the thread; per-message ones not. */
  save: boolean;
  threadId: string;
  localView: AssistantView;
  hostedView: AssistantView;
  localLabel: string;
  hostedLabel: string;
}

const compareRuns = new Map<string, CompareRun>();

/** A small "Second opinion" action on a user message, offered only while it
 * can run (signed in, an engine ready, Private Mode off). */
function addSecondOpinionButton(userItem: HTMLElement, req: OutgoingRequest): void {
  if (!secondOpinionOk()) return;
  const b = el("button", "vd-msg-tool");
  b.type = "button";
  b.append(icon("columns"), el("span", undefined, "Second opinion"));
  b.title = "Run this message on this machine and on your agent, side by side";
  b.addEventListener("click", () => {
    if (busy()) {
      setNotice("Wait for the current answer to finish, or press Esc to stop it.");
      return;
    }
    if (!secondOpinionOk()) {
      setNotice(
        state.privateMode
          ? "Second opinion needs your hosted agent, so it is off while Private Mode is on."
          : "Second opinion needs you signed in and an on-device model ready.",
        "error"
      );
      return;
    }
    void runCompare(req, false);
  });
  userItem.append(b);
}

/** Run the same prompt on the on-device engine AND the selected hosted agent,
 * side by side (stacked when narrow). Both see only this message - never the
 * earlier conversation - so the comparison is fair. */
async function runCompare(req: OutgoingRequest, save: boolean): Promise<void> {
  const agentId = state.selectedAgentId;
  if (!engineHost || !agentId || !secondOpinionOk()) {
    dispatch(req);
    return;
  }
  clearRetryButtons();
  const compareId = nextReqId("cmp");
  const wrap = el("div", "msg vd-compare");
  wrap.append(el("div", "vd-compare-note", "Second opinion - both answers see only this message, not the earlier conversation."));
  const grid = el("div", "vd-compare-grid");
  const colLocal = el("div", "vd-compare-col");
  const colHosted = el("div", "vd-compare-col");
  const localLabel = `On this machine (${state.engine.modelId ? shortModelName(state.engine.modelId) : state.engine.backend ?? "on-device"})`;
  const hostedLabel = selectedAgentName() ?? "Your agent";
  colLocal.append(el("div", "vd-compare-label", localLabel));
  colHosted.append(el("div", "vd-compare-label", hostedLabel));
  grid.append(colLocal, colHosted);
  wrap.append(grid);
  appendNode(wrap);
  const localView = createAssistantView(colLocal);
  const hostedView = createAssistantView(colHosted);
  const hostedReqId = nextReqId("chat");
  const localReqId = nextReqId("local");
  compareRuns.set(compareId, {
    hostedReqId,
    localReqId,
    remaining: 2,
    save,
    threadId: req.threadId,
    localView,
    hostedView,
    localLabel,
    hostedLabel,
  });
  state.streamingReqId = compareId;
  setStreamingUi(true);

  hostedViews.set(hostedReqId, { view: hostedView, req, compareId });
  transport.post({ type: "chat.send", reqId: hostedReqId, agentId, message: hostedMessage(req), sessionId: null });

  const systemPrompt = localSystemPrompt(req);
  const fit = fitContextForLocal(req.instruction, req.items, systemPrompt, activeContextWindow());
  if (!fit.fits) {
    localView.showError("Too long for the on-device model's context window.");
    localView.finish({ retryable: false, standalone: true });
    compareSettled(compareId);
    return;
  }
  localReqs.add(localReqId);
  let streamed = "";
  const result = await engineHost.run(
    localReqId,
    "chat",
    { text: buildPrompt(req.instruction, fit.items), systemPrompt },
    (delta) => {
      streamed += delta;
      localView.setText(streamed, false);
    }
  );
  localReqs.delete(localReqId);
  if (result.ok && result.text) {
    localView.setText(result.text, true);
  } else if (result.reason === "aborted") {
    if (streamed) localView.setText(streamed, true);
    localView.showError(streamed ? "Stopped." : "Stopped before any answer.");
  } else {
    localView.showError(`On-device answer failed: ${describeLocalFailure(result.reason)}`);
  }
  localView.finish({ command: req.command, retryable: false, req, standalone: true });
  compareSettled(compareId);
}

function compareSettled(compareId: string): void {
  const run = compareRuns.get(compareId);
  if (!run) return;
  run.remaining -= 1;
  if (run.remaining > 0) return;
  compareRuns.delete(compareId);
  if (run.save) {
    const parts = [
      `**${run.localLabel}**`,
      "",
      run.localView.text || "(no answer)",
      "",
      `**${run.hostedLabel}**`,
      "",
      run.hostedView.text || "(no answer)",
    ];
    history.append(run.threadId, { role: "assistant", text: parts.join("\n") });
  }
  if (state.streamingReqId === compareId) {
    state.streamingReqId = null;
    setStreamingUi(false);
  }
}

// --- messenger moment ---------------------------------------------------------------

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** VegaDūta means "swift messenger": on send, the emblem makes a brief flight
 * from the Send button toward the new message. Fixed-position and
 * pointer-events:none, so nothing reflows; skipped entirely under
 * prefers-reduced-motion (the CSS hides .vd-flight there too). */
function flyEmblem(target: HTMLElement): void {
  if (reducedMotion()) return;
  const sendButton = document.getElementById("composer-send");
  if (!sendButton) return;
  const from = sendButton.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!from.width || !to.width) return;
  const img = brandMark(18, "vd-flight");
  const startX = from.left + from.width / 2 - img.width / 2;
  const startY = from.top - img.height;
  img.style.left = `${startX}px`;
  img.style.top = `${startY}px`;
  document.body.append(img);
  const dx = Math.min(to.right - 12, window.innerWidth - 24) - img.width - startX;
  const dy = Math.max(8, to.top + 4) - startY;
  const cleanup = () => img.remove();
  if (typeof img.animate !== "function") {
    cleanup();
    return;
  }
  try {
    const anim = img.animate(
      [
        { transform: "translate(0, 0) scale(0.7) rotate(0deg)", opacity: 0 },
        { opacity: 0.95, offset: 0.2 },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.55 - 14}px) scale(0.85) rotate(-6deg)`, opacity: 0.85, offset: 0.6 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.6) rotate(-10deg)`, opacity: 0 },
      ],
      { duration: 620, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" }
    );
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
  } catch {
    cleanup();
    return;
  }
  window.setTimeout(cleanup, 1500);
}

function finishStream(reqId: string): void {
  hostedViews.delete(reqId);
  if (state.streamingReqId === reqId) {
    state.streamingReqId = null;
    setStreamingUi(false);
  }
}

function abortCurrent(): void {
  const reqId = state.streamingReqId;
  if (!reqId) return;
  const cmp = compareRuns.get(reqId);
  if (cmp) {
    if (localReqs.has(cmp.localReqId)) engineHost?.abort(cmp.localReqId);
    if (hostedViews.has(cmp.hostedReqId)) transport.post({ type: "chat.abort", reqId: cmp.hostedReqId });
    return;
  }
  if (localReqs.has(reqId)) {
    engineHost?.abort(reqId);
  } else {
    transport.post({ type: "chat.abort", reqId });
  }
}

function retryLast(): void {
  if (busy() || !lastRequest || !thread || lastRequest.threadId !== thread.id) return;
  const all = Array.from(messagesEl().querySelectorAll(".msg-assistant"));
  all[all.length - 1]?.remove();
  history.popAssistant(thread.id);
  if (localTurns.length >= 2 && localTurns[localTurns.length - 1].role === "assistant") localTurns.splice(-2, 2);
  dispatch(lastRequest);
}

// --- run-in-sandbox flow ----------------------------------------------------------------------

/** Finds the FIRST fenced code block in the composer text, e.g. from
 * ```python\n...\n``` - the same shape selection.context writes there. */
function extractFirstFence(text: string): { code: string; languageId?: string } | null {
  const match = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/.exec(text);
  if (!match) return null;
  return { languageId: match[1] || undefined, code: match[2] };
}

const runResults = new Map<string, HTMLElement>();

function runInSandbox(): void {
  const fence = extractFirstFence(composerInput().value);
  if (!fence) {
    appendSystem("Select or paste a fenced code block (```) to run it in a sandbox.");
    return;
  }
  runCode(fence.code, fenceLangToLanguageId(fence.languageId ?? ""));
}

function runCode(code: string, languageId?: string): void {
  if (state.privateMode) {
    appendSystem("The code sandbox runs in the cloud, so it is off while Private Mode is on.", "error");
    return;
  }
  const reqId = nextReqId("run");
  runResults.set(reqId, appendSystem("Running in sandbox…"));
  transport.post({ type: "sdlc.run", reqId, code, languageId });
}

function renderRunResult(message: Extract<HostToWebview, { type: "sdlc.run.result" }>): void {
  const card = runResults.get(message.reqId);
  runResults.delete(message.reqId);
  if (!card) return;
  if (!message.ok) {
    card.parentElement?.classList.add("msg-error");
    card.textContent = `Run failed: ${message.detail ?? message.reason ?? "unknown error"}`;
    return;
  }
  const parts: string[] = [];
  if (message.stdout) parts.push(message.stdout.replace(/\n$/, ""));
  if (message.stderr) parts.push(`stderr:\n${message.stderr.replace(/\n$/, "")}`);
  if (message.timedOut) parts.push("(timed out)");
  parts.push(`exit code ${message.exitCode ?? "?"}`);
  card.textContent = "";
  card.append(el("div", "vd-run-title", "Sandbox output"), el("pre", "vd-run-output", parts.join("\n\n") || "(no output)"));
}

// --- workflow flow -----------------------------------------------------------------------------

const workflowCards = new Map<string, HTMLElement>();

function runWorkflow(workflowId: string, input = ""): void {
  const wf = state.workflows.find((w) => w.id === workflowId);
  if (!wf) return;
  if (state.privateMode) {
    appendSystem("Workflows run on the server, so they are off while Private Mode is on.", "error");
    return;
  }
  const reqId = nextReqId("wf");
  const card = appendSystem(
    input ? `Running workflow "${wf.name}" with this answer as its input…` : `Running workflow "${wf.name}"…`
  );
  workflowCards.set(reqId, card);
  transport.post({ type: "workflow.run", reqId, workflowId, input });
}

function renderWorkflowStatus(reqId: string, run: WorkflowRun): void {
  const card = workflowCards.get(reqId);
  if (!card) return;
  const terminal = TERMINAL_RUN_STATUSES.has(run.status);
  card.textContent = `Workflow "${run.workflowName ?? run.workflowId}": ${run.status}${
    run.errorMessage ? ` — ${run.errorMessage}` : ""
  }`;
  if (terminal) workflowCards.delete(reqId);
}

// --- host messages -----------------------------------------------------------------------------

/** Apply the host's edge.* seed to the engine kv (localStorage) before the
 * engine host reads it. Null removes; "" is treated as unset too. */
function applyEdgeSettings(settings: Record<string, string | null> | undefined): void {
  if (!settings) return;
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith("edge.")) continue;
    try {
      if (value == null || value === "") localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // A blocked localStorage degrades to defaults - same as createDefaultKv.
    }
  }
}

function onPrefill(message: Extract<HostToWebview, { type: "ui.prefill" }>): void {
  const input = composerInput();
  if (busy()) {
    setNotice("Finish or stop the current answer first, then try that again.", "error");
    return;
  }
  input.value = typeof message.text === "string" ? message.text : "";
  input.focus();
  autoGrow();
  renderSlash();
  const requested = message.context ?? [];
  const unsupported = requested.filter((k) => !state.capabilities.context.includes(k));
  if (unsupported.length) {
    setNotice(`This host can't attach ${unsupported.join(", ")}.`, "error");
  }
  const kinds = requested.filter((k) => state.capabilities.context.includes(k));
  if (kinds.length === 0) {
    if (message.send) submit();
    return;
  }
  state.gathering = true;
  renderComposer();
  requestContext(kinds, (ok) => {
    state.gathering = false;
    renderComposer();
    if (ok && message.send) submit();
  });
}

function onHostMessage(message: HostToWebview): void {
  switch (message.type) {
    case "init":
      if (message.theme === "dark" || message.theme === "light") {
        document.body.classList.remove("vd-theme-dark", "vd-theme-light");
        document.body.classList.add(`vd-theme-${message.theme}`);
      }
      state.auth = message.auth;
      state.agents = message.agents;
      state.workflows = message.workflows;
      state.hostLocalEngine = message.hostLocalEngine;
      state.apiBase = message.apiBase;
      state.platform = message.platform;
      state.capabilities = normalizeCapabilities(message.capabilities);
      if (!state.localModeChosen) state.localMode = !message.auth.signedIn;
      applyEdgeSettings(message.edgeSettings);
      // Tell the host where Private Mode stands on every (re)init, so a host
      // that enforces it blocks its own hosted paths from the first moment.
      transport.post({ type: "privacy.mode", private: state.privateMode });
      renderAuth();
      renderAgents();
      renderEngine();
      renderPrivacy();
      if (state.toolkitOpen) renderToolkit();
      renderRoomHint();
      if (message.hostLocalEngine && !engineHost) {
        void startEngineHost();
      }
      break;
    case "auth.changed": {
      const wasSignedIn = state.auth.signedIn;
      state.auth = message.auth;
      if (!state.localModeChosen) state.localMode = !message.auth.signedIn;
      if (wasSignedIn && !message.auth.signedIn && thread?.mode === "hosted") newChat();
      renderAuth();
      renderEngine();
      if (state.toolkitOpen) renderToolkit();
      break;
    }
    case "agents.changed":
      state.agents = message.agents;
      state.workflows = message.workflows;
      renderAgents();
      break;
    case "ui.showModels":
      void toggleModels(true);
      break;
    case "ui.prefill":
      onPrefill(message);
      break;
    case "context.result":
      onContextResult(message);
      break;
    case "chat.chunk": {
      const entry = hostedViews.get(message.reqId);
      if (entry) entry.view.setText(entry.view.text + message.delta, false);
      break;
    }
    case "chat.done": {
      const entry = hostedViews.get(message.reqId);
      if (entry?.compareId) {
        if (entry.view.text) entry.view.setText(entry.view.text, true);
        else entry.view.showError("The agent returned an empty answer.");
        entry.view.finish({ command: entry.req.command, retryable: false, req: entry.req, standalone: true });
        hostedViews.delete(message.reqId);
        compareSettled(entry.compareId);
        break;
      }
      if (entry) {
        const threadId = entry.req.threadId;
        if (message.sessionId) history.setSession(threadId, message.sessionId);
        if (entry.view.text) {
          entry.view.setText(entry.view.text, true);
          history.append(threadId, { role: "assistant", text: entry.view.text, command: entry.req.command });
        } else {
          entry.view.showError("The agent returned an empty answer.");
        }
        entry.view.finish({ command: entry.req.command, retryable: true, req: entry.req });
      }
      finishStream(message.reqId);
      break;
    }
    case "chat.error": {
      const entry = hostedViews.get(message.reqId);
      if (entry?.compareId) {
        entry.view.showError(message.message);
        entry.view.finish({ retryable: false, standalone: true });
        hostedViews.delete(message.reqId);
        compareSettled(entry.compareId);
        break;
      }
      if (entry) {
        entry.view.showError(message.message);
        history.append(entry.req.threadId, {
          role: "assistant",
          text: entry.view.text ? `${entry.view.text}\n\n(${message.message})` : message.message,
          error: true,
        });
        entry.view.finish({ command: entry.req.command, retryable: true, req: entry.req });
      } else {
        appendSystem(message.message, "error");
      }
      finishStream(message.reqId);
      break;
    }
    case "workflow.status":
      renderWorkflowStatus(message.reqId, message.run);
      break;
    case "workflow.error": {
      const card = workflowCards.get(message.reqId);
      if (card) {
        card.parentElement?.classList.add("msg-error");
        card.textContent = message.message;
      }
      workflowCards.delete(message.reqId);
      break;
    }
    case "selection.context": {
      const input = composerInput();
      const fence = message.languageId ? "```" + message.languageId : "```";
      input.value = `${input.value ? input.value + "\n" : ""}${fence}\n${message.text}\n\`\`\`\n`;
      input.focus();
      autoGrow();
      break;
    }
    case "engine.request":
      void handleEngineRequest(message);
      break;
    case "engine.abort":
      engineHost?.abort(message.reqId);
      break;
    case "sdlc.run.result":
      renderRunResult(message);
      break;
    case "knowledge.result":
      onKnowledgeResult(message);
      break;
    case "privacy.state":
      // The webview's own switch is the source of truth; the host only says
      // whether it enforces Private Mode on its own paths too.
      state.privacyEnforced = message.private === true && message.enforced === true && state.privateMode;
      renderPrivacy();
      break;
  }
}

// --- optional in-webview engine host (loaded lazily behind a dynamic import
// so hosts that never enable local inference don't pay for the WebLLM
// bundle) ---------------------------------------------------------------------

let engineHost: EngineHost | null = null;

async function startEngineHost(): Promise<void> {
  try {
    const mod = (await import("../engineHost")) as unknown as {
      createEngineHost(config?: { apiBase?: string; platform?: EnginePlatform }): EngineHost;
    };
    engineHost = mod.createEngineHost({
      apiBase: state.apiBase || undefined,
      platform: state.platform,
    });
    try {
      engineHost.setPrivateMode(state.privateMode);
    } catch {
      // An older engine build without Private Mode: the transport guard and
      // every UI gate still hold.
    }
    await engineHost.start((status) => {
      const wasReady = state.engine.state === "ready";
      state.engine = status;
      renderEngine();
      if (wasReady !== (status.state === "ready")) renderAuth();
      transport.post({ type: "engine.status", status });
    });
    renderAuth();
    // Prefetch the list so the chip's click opens an already-populated panel
    // (and the active model's context window is known for attachment trimming).
    void refreshModels();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    state.engine = { state: "unavailable", detail };
    renderEngine();
    transport.post({ type: "engine.status", status: state.engine });
  }
}

async function handleEngineRequest(message: Extract<HostToWebview, { type: "engine.request" }>): Promise<void> {
  if (!engineHost) {
    transport.post({ type: "engine.result", reqId: message.reqId, ok: false, reason: "engine-off" });
    return;
  }
  const result = await engineHost.run(message.reqId, message.kind, message.payload);
  transport.post({ type: "engine.result", reqId: message.reqId, ...result });
}

// --- boot ----------------------------------------------------------------------------------------

const COMPOSER_MAX_HEIGHT = 200;

function autoGrow(): void {
  const input = composerInput();
  input.style.height = "auto";
  input.style.height = `${Math.min(COMPOSER_MAX_HEIGHT, input.scrollHeight)}px`;
}

/** Builds the composer extras (context bar, slash popup, hint) inside the
 * existing .composer footer - no new ids required from index.html. */
function mountComposerExtras(): void {
  const input = composerInput();
  const footer = input.closest(".composer") ?? input.parentElement;
  if (!footer || document.getElementById("vd-context-bar")) return;
  footer.classList.add("vd-composer");

  const bar = el("div", "vd-context-bar");
  bar.id = "vd-context-bar";
  bar.hidden = true;
  footer.prepend(bar);

  const popup = el("div", "vd-slash");
  popup.id = "vd-slash";
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "Commands");
  popup.hidden = true;
  footer.prepend(popup);

  const hint = el("div", "vd-hint");
  hint.id = "vd-hint";
  footer.append(hint);

  input.setAttribute("aria-label", "Message");
  input.setAttribute("aria-controls", "vd-slash");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
}

export function bootChatApp(injected?: WebviewTransport): void {
  const found = injected ?? detectTransport();
  if (!found) {
    document.body.textContent = "No host transport available.";
    return;
  }
  const storage = safeLocalStorage();
  prefsStorage = storage;
  const prefs = loadPrefs(storage);
  state.role = prefs.role;
  state.onboarded = prefs.onboarded;
  state.privateMode = prefs.privateMode;
  // Private Mode's last line of defence: whatever a UI path does, content-
  // carrying hosted requests are dropped here while it is on.
  transport = createPrivacyGuard(found, () => state.privateMode, (blocked) => {
    setNotice(`Blocked a ${blocked.type} request - Private Mode is on, so nothing is sent off this machine.`, "error");
  });
  history = new HistoryStore(storage);
  userRecipes = new UserRecipeStore(storage, BUILT_IN_COMMAND_NAMES);
  transport.onMessage(onHostMessage);

  mountHeader();
  mountComposerExtras();
  watchRoom();

  const input = composerInput();
  ($("composer-send") as HTMLButtonElement).addEventListener("click", () => {
    if (state.streamingReqId) abortCurrent();
    else submit();
  });
  input.addEventListener("input", () => {
    noteTyping();
    autoGrow();
    slashIndex = 0;
    renderSlash();
  });
  input.addEventListener("keydown", (event) => {
    if (slashMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
        renderSlash();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
        renderSlash();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        acceptSlash(slashIndex, false);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        acceptSlash(slashIndex, true);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!state.streamingReqId) submit();
    }
  });
  input.addEventListener("blur", () => window.setTimeout(closeSlash, 150));

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.streamingReqId) {
      event.preventDefault();
      abortCurrent();
    } else if (contextMenuOpen) {
      contextMenuOpen = false;
      renderContextBar();
    } else if (state.toolkitOpen) {
      toggleToolkit(false);
    } else if (state.historyOpen) {
      toggleHistory(false);
    }
  });

  messagesEl().addEventListener("scroll", () => {
    const list = messagesEl();
    userScrolledUp = list.scrollHeight - list.scrollTop - list.clientHeight > 48;
  });

  const runButton = document.getElementById("composer-run") as HTMLButtonElement | null;
  runButton?.addEventListener("click", runInSandbox);

  ($("workflow-select") as HTMLSelectElement).addEventListener("change", (event) => {
    const workflowId = (event.target as HTMLSelectElement).value;
    if (workflowId) {
      runWorkflow(workflowId);
      (event.target as HTMLSelectElement).value = "";
    }
  });
  ($("agent-select") as HTMLSelectElement).addEventListener("change", (event) => {
    state.selectedAgentId = (event.target as HTMLSelectElement).value || null;
    // New agent, new conversation (the server session belongs to the old one).
    if (thread && thread.mode === "hosted" && thread.messages.length > 0) newChat();
    renderComposer();
  });
  const chip = $("engine-chip");
  chip.addEventListener("click", () => {
    if (state.hostLocalEngine) void toggleModels();
  });
  chip.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && state.hostLocalEngine) {
      event.preventDefault();
      void toggleModels();
    }
  });

  renderAuth();
  renderAgents();
  renderEngine();
  transport.post({ type: "ready" });
}

// Auto-boot when loaded directly by VS Code / JCEF / SWT pages. Chrome's side
// panel imports bootChatApp and passes its loopback transport instead; the
// data attribute lets it opt out of the auto-boot.
if (typeof document !== "undefined" && !document.body?.dataset.manualBoot) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => bootChatApp());
  } else {
    bootChatApp();
  }
}
