// Pure (DOM-free) logic behind the Toolkit: roles, SDLC phases, which recipes
// a host can run, how they are ordered for a role, how a recipe's prompt is
// filled, the person's own recipes (stored locally) and STRICT validation of
// imported recipe JSON. Kept out of main.ts so every rule here is unit-tested.
//
// Imported text is UNTRUSTED: validateRecipe accepts exactly the Recipe shape
// (no unknown keys, bounded lengths, known enums) and rejects everything else.
// Recipe text is only ever rendered with textContent and sent as a prompt.

import type { ContextKind, HostCapabilities } from "../protocol";
import type { KeyValueStorage } from "./history";
import { ALL_CONTEXT_KINDS, type SlashCommand } from "./commands";
import type { Recipe, RecipeOutput, Role, SdlcPhase } from "./recipes/types";

// --- roles and phases ------------------------------------------------------------

export interface RoleInfo {
  id: Role;
  label: string;
  /** One line for the first-run picker. */
  blurb: string;
}

export const ROLES: RoleInfo[] = [
  { id: "developer", label: "Developer", blurb: "Write, understand and fix code" },
  { id: "tester", label: "Tester / QA", blurb: "Test cases, test data and automation" },
  { id: "reviewer", label: "Reviewer", blurb: "Review changes and catch problems early" },
  { id: "architect", label: "Architect", blurb: "Designs, decisions and diagrams" },
  { id: "product", label: "Product / BA", blurb: "Stories, acceptance criteria and specs" },
  { id: "devops", label: "DevOps", blurb: "Pipelines, releases and incidents" },
];

export const ROLE_IDS: ReadonlySet<string> = new Set(ROLES.map((r) => r.id));

export interface PhaseInfo {
  id: SdlcPhase;
  label: string;
}

export const PHASES: PhaseInfo[] = [
  { id: "plan", label: "Plan" },
  { id: "design", label: "Design" },
  { id: "build", label: "Build" },
  { id: "test", label: "Test" },
  { id: "review", label: "Review" },
  { id: "release", label: "Release" },
  { id: "operate", label: "Operate" },
  { id: "automate", label: "Automate" },
];

export const PHASE_IDS: ReadonlySet<string> = new Set(PHASES.map((p) => p.id));

/** Which phases each role reaches for first. Every phase appears exactly once
 * per role - the order is emphasis, never exclusion. */
export const ROLE_PHASE_ORDER: Record<Role, SdlcPhase[]> = {
  developer: ["build", "test", "review", "design", "release", "operate", "automate", "plan"],
  tester: ["test", "plan", "review", "build", "automate", "release", "operate", "design"],
  reviewer: ["review", "test", "build", "design", "release", "plan", "operate", "automate"],
  architect: ["design", "plan", "review", "build", "operate", "release", "test", "automate"],
  product: ["plan", "design", "test", "release", "review", "build", "operate", "automate"],
  devops: ["operate", "release", "automate", "build", "test", "review", "design", "plan"],
};

export function roleLabel(role: Role | null | undefined): string {
  return ROLES.find((r) => r.id === role)?.label ?? "Developer";
}

export function phaseLabel(phase: SdlcPhase): string {
  return PHASES.find((p) => p.id === phase)?.label ?? phase;
}

// --- availability, ordering, search ------------------------------------------------

/** Context kinds of `recipe` this host can supply. */
export function recipeContextKinds(recipe: Recipe, caps: HostCapabilities): ContextKind[] {
  return recipe.context.filter((k) => caps.context.includes(k));
}

/** False when the recipe is pointless here: it requires context and the host
 * can supply none of the kinds it wants. */
export function recipeAvailable(recipe: Recipe, caps: HostCapabilities): boolean {
  if (!recipe.requiresContext) return true;
  return recipeContextKinds(recipe, caps).length > 0;
}

function matchesQuery(recipe: Recipe, q: string): boolean {
  if (!q) return true;
  const hay = [recipe.name, recipe.description, recipe.slash ?? "", recipe.phase, ...recipe.roles]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word.replace(/^\//, "")));
}

export interface RecipeGroup {
  phase: SdlcPhase;
  label: string;
  recipes: Recipe[];
}

/** Recipes the host can run, filtered by `query`, grouped by phase in the
 * role's order; within a phase: primary-role recipes first, then recipes that
 * list the role, then the rest (stable within each tier). Empty groups are
 * dropped. */
export function groupRecipes(
  recipes: Recipe[],
  opts: { role: Role; query?: string; capabilities: HostCapabilities }
): RecipeGroup[] {
  const q = (opts.query ?? "").trim();
  const usable = recipes.filter((r) => recipeAvailable(r, opts.capabilities) && matchesQuery(r, q));
  const tier = (r: Recipe) => (r.roles[0] === opts.role ? 0 : r.roles.includes(opts.role) ? 1 : 2);
  const order = ROLE_PHASE_ORDER[opts.role] ?? ROLE_PHASE_ORDER.developer;
  const groups: RecipeGroup[] = [];
  for (const phase of order) {
    const inPhase = usable
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.phase === phase)
      .sort((a, b) => tier(a.r) - tier(b.r) || a.i - b.i)
      .map(({ r }) => r);
    if (inPhase.length) groups.push({ phase, label: phaseLabel(phase), recipes: inPhase });
  }
  return groups;
}

// --- filling ---------------------------------------------------------------------------

const INPUT_TOKEN = /\{\{\s*input\s*\}\}/g;

/** The recipe's prompt with every {{input}} replaced by what the person typed.
 * A replacer FUNCTION is used so "$&" / "$1" in the input stay literal. When
 * the prompt has no {{input}} and the person typed something, it is appended
 * as a note so it is never silently dropped. */
export function fillRecipePrompt(recipe: Pick<Recipe, "prompt">, input: string): string {
  const text = input.trim();
  const hasToken = new RegExp(INPUT_TOKEN.source).test(recipe.prompt);
  if (!hasToken) {
    return text ? `${recipe.prompt.trim()}\n\nMy note: ${text}` : recipe.prompt.trim();
  }
  const filled = recipe.prompt.replace(INPUT_TOKEN, () => text);
  // An empty input can leave "Topic: " or blank runs behind - tidy them.
  return filled.replace(/\n{3,}/g, "\n\n").trim();
}

/** True when the recipe's prompt takes {{input}} (the UI asks for it). */
export function recipeTakesInput(recipe: Pick<Recipe, "prompt">): boolean {
  return new RegExp(INPUT_TOKEN.source).test(recipe.prompt);
}

// --- slash aliases ---------------------------------------------------------------------

export const SLASH_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/** Why `alias` cannot be used, or null when it can. */
export function slashAliasProblem(
  alias: string,
  builtIns: ReadonlySet<string>,
  taken: ReadonlySet<string> = new Set()
): string | null {
  if (!SLASH_ALIAS_PATTERN.test(alias)) {
    return "A slash alias is 1-24 lowercase letters, digits or dashes, starting with a letter.";
  }
  if (builtIns.has(alias)) return `/${alias} is a built-in command.`;
  if (taken.has(alias)) return `/${alias} is already used by another recipe.`;
  return null;
}

export interface RecipeSlashResult {
  commands: SlashCommand[];
  /** Aliases that were refused, with why - shown in the Toolkit, never fatal. */
  rejected: Array<{ recipeId: string; alias: string; reason: string }>;
}

/** Slash commands for recipes with aliases the host can run. Built-in
 * commands always win; between recipes the first one (built-ins come before
 * the person's own) keeps the alias. */
export function recipeSlashCommands(
  recipes: Recipe[],
  caps: HostCapabilities,
  builtIns: ReadonlySet<string>
): RecipeSlashResult {
  const taken = new Set<string>();
  const commands: SlashCommand[] = [];
  const rejected: RecipeSlashResult["rejected"] = [];
  for (const r of recipes) {
    if (!r.slash || !recipeAvailable(r, caps)) continue;
    const alias = r.slash.toLowerCase();
    const problem = slashAliasProblem(alias, builtIns, taken);
    if (problem) {
      rejected.push({ recipeId: r.id, alias, reason: problem });
      continue;
    }
    taken.add(alias);
    commands.push({
      name: alias,
      description: r.name,
      action: "prompt",
      template: r.prompt,
      context: r.context,
      requiresContext: r.requiresContext,
      recipeId: r.id,
    });
  }
  return { commands, rejected };
}

// --- strict validation (imports and the editor) -----------------------------------------

export const RECIPE_LIMITS = {
  id: 64,
  name: 80,
  description: 300,
  prompt: 8000,
  /** Whole import payload, characters. */
  importChars: 200_000,
  importCount: 100,
};

const RECIPE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "description",
  "phase",
  "roles",
  "slash",
  "context",
  "requiresContext",
  "prompt",
  "output",
  "localFriendly",
  "builtIn",
]);
const OUTPUT_KEYS: ReadonlySet<string> = new Set(["kind", "languageId", "offerNewFile", "offerCommitMessage", "offerWorkflow"]);
const OUTPUT_KINDS: ReadonlySet<string> = new Set(["markdown", "code", "csv", "json", "mermaid"]);
const CONTEXT_KIND_SET: ReadonlySet<string> = new Set(ALL_CONTEXT_KINDS);
export const RECIPE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LANGUAGE_ID_PATTERN = /^[A-Za-z0-9_.+-]{1,40}$/;
/** C0 controls other than tab/newline/CR, plus bidi overrides that can make
 * a prompt read differently from what is sent. */
function hasUnsafeChars(v: string): boolean {
  for (let i = 0; i < v.length; i += 1) {
    const c = v.charCodeAt(i);
    if (c <= 8 || c === 11 || c === 12 || (c >= 14 && c <= 31) || c === 127) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function checkString(
  v: unknown,
  field: string,
  max: number,
  opts: { multiline?: boolean; optional?: boolean } = {}
): string | null {
  if (v === undefined && opts.optional) return null;
  if (typeof v !== "string") return `"${field}" must be text.`;
  if (!v.trim()) return `"${field}" must not be empty.`;
  if (v.length > max) return `"${field}" is longer than ${max} characters.`;
  if (hasUnsafeChars(v)) return `"${field}" contains control or text-direction characters.`;
  if (!opts.multiline && /[\r\n]/.test(v)) return `"${field}" must be a single line.`;
  return null;
}

export type RecipeValidation = { ok: true; recipe: Recipe } | { ok: false; error: string };

/** Validate an untrusted value against the Recipe shape. Unknown keys are an
 * error (not silently dropped) so a hostile or mistaken file is visible. The
 * result is a fresh object built field by field, always builtIn:false. */
export function validateRecipe(raw: unknown, opts: { builtInCommands: ReadonlySet<string> }): RecipeValidation {
  if (!isPlainObject(raw)) return { ok: false, error: "A recipe must be a JSON object." };
  for (const key of Object.keys(raw)) {
    if (!RECIPE_KEYS.has(key)) return { ok: false, error: `Unknown field "${key.slice(0, 40)}".` };
  }
  const r = raw;
  const fail = (error: string): RecipeValidation => ({ ok: false, error });

  if (typeof r.id !== "string" || !RECIPE_ID_PATTERN.test(r.id) || r.id.length > RECIPE_LIMITS.id) {
    return fail(`"id" must be kebab-case (a-z, 0-9, dashes), at most ${RECIPE_LIMITS.id} characters.`);
  }
  const strErr =
    checkString(r.name, "name", RECIPE_LIMITS.name) ??
    checkString(r.description, "description", RECIPE_LIMITS.description) ??
    checkString(r.prompt, "prompt", RECIPE_LIMITS.prompt, { multiline: true });
  if (strErr) return fail(strErr);
  if (typeof r.phase !== "string" || !PHASE_IDS.has(r.phase)) {
    return fail(`"phase" must be one of: ${[...PHASE_IDS].join(", ")}.`);
  }
  if (!Array.isArray(r.roles) || r.roles.length === 0 || r.roles.length > ROLES.length) {
    return fail(`"roles" must list 1-${ROLES.length} roles.`);
  }
  if (!r.roles.every((x) => typeof x === "string" && ROLE_IDS.has(x)) || new Set(r.roles).size !== r.roles.length) {
    return fail(`"roles" may only contain: ${[...ROLE_IDS].join(", ")} (no repeats).`);
  }
  if (!Array.isArray(r.context) || r.context.length > ALL_CONTEXT_KINDS.length) {
    return fail(`"context" must be a list of context kinds (it may be empty).`);
  }
  if (!r.context.every((x) => typeof x === "string" && CONTEXT_KIND_SET.has(x)) || new Set(r.context).size !== r.context.length) {
    return fail(`"context" may only contain: ${ALL_CONTEXT_KINDS.join(", ")} (no repeats).`);
  }
  if (r.requiresContext !== undefined && typeof r.requiresContext !== "boolean") {
    return fail(`"requiresContext" must be true or false.`);
  }
  if (r.requiresContext === true && r.context.length === 0) {
    return fail(`"requiresContext" is true but "context" is empty.`);
  }
  if (typeof r.localFriendly !== "boolean") return fail(`"localFriendly" must be true or false.`);
  if (r.builtIn !== undefined && r.builtIn !== false) {
    return fail(`"builtIn" must be false (or left out) - only VegaDūta ships built-in recipes.`);
  }
  let slash: string | undefined;
  if (r.slash !== undefined) {
    if (typeof r.slash !== "string") return fail(`"slash" must be text.`);
    const problem = slashAliasProblem(r.slash, opts.builtInCommands);
    if (problem) return fail(problem);
    slash = r.slash;
  }
  let output: RecipeOutput | undefined;
  if (r.output !== undefined) {
    if (!isPlainObject(r.output)) return fail(`"output" must be an object.`);
    for (const key of Object.keys(r.output)) {
      if (!OUTPUT_KEYS.has(key)) return fail(`Unknown field "output.${key.slice(0, 40)}".`);
    }
    const o = r.output;
    if (typeof o.kind !== "string" || !OUTPUT_KINDS.has(o.kind)) {
      return fail(`"output.kind" must be one of: ${[...OUTPUT_KINDS].join(", ")}.`);
    }
    if (o.languageId !== undefined && (typeof o.languageId !== "string" || !LANGUAGE_ID_PATTERN.test(o.languageId))) {
      return fail(`"output.languageId" must be a short language id such as "typescript".`);
    }
    for (const flag of ["offerNewFile", "offerCommitMessage", "offerWorkflow"] as const) {
      if (o[flag] !== undefined && typeof o[flag] !== "boolean") return fail(`"output.${flag}" must be true or false.`);
    }
    output = {
      kind: o.kind as RecipeOutput["kind"],
      ...(typeof o.languageId === "string" ? { languageId: o.languageId } : {}),
      ...(o.offerNewFile === true ? { offerNewFile: true } : {}),
      ...(o.offerCommitMessage === true ? { offerCommitMessage: true } : {}),
      ...(o.offerWorkflow === true ? { offerWorkflow: true } : {}),
    };
  }
  const recipe: Recipe = {
    id: r.id,
    name: (r.name as string).trim(),
    description: (r.description as string).trim(),
    phase: r.phase as SdlcPhase,
    roles: [...(r.roles as Role[])],
    ...(slash ? { slash } : {}),
    context: [...(r.context as ContextKind[])],
    ...(r.requiresContext === true ? { requiresContext: true } : {}),
    prompt: r.prompt as string,
    ...(output ? { output } : {}),
    localFriendly: r.localFriendly,
    builtIn: false,
  };
  return { ok: true, recipe };
}

export type RecipeImport = { ok: true; recipes: Recipe[] } | { ok: false; error: string };

/** Parse pasted JSON: an array of recipes, or { "recipes": [...] } as Export
 * writes it. All-or-nothing: one invalid recipe rejects the whole import and
 * the message says which one and why. Ids of built-in recipes are refused. */
export function parseRecipeImport(
  text: string,
  opts: { builtInCommands: ReadonlySet<string>; builtInIds: ReadonlySet<string> }
): RecipeImport {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Paste the recipe JSON first." };
  if (text.length > RECIPE_LIMITS.importChars) {
    return { ok: false, error: `That is too large to import (over ${RECIPE_LIMITS.importChars.toLocaleString()} characters).` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "That is not valid JSON." };
  }
  let list: unknown;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (isPlainObject(parsed)) {
    for (const key of Object.keys(parsed)) {
      if (key !== "recipes" && key !== "format" && key !== "version") {
        return { ok: false, error: `Unknown top-level field "${key.slice(0, 40)}". Expected { "recipes": [...] } or a list.` };
      }
    }
    list = parsed.recipes;
  }
  if (!Array.isArray(list)) return { ok: false, error: 'Expected a list of recipes, or { "recipes": [...] }.' };
  if (list.length === 0) return { ok: false, error: "There are no recipes in that JSON." };
  if (list.length > RECIPE_LIMITS.importCount) {
    return { ok: false, error: `At most ${RECIPE_LIMITS.importCount} recipes can be imported at once.` };
  }
  const out: Recipe[] = [];
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const v = validateRecipe(list[i], { builtInCommands: opts.builtInCommands });
    const where = `Recipe ${i + 1}`;
    if (!v.ok) return { ok: false, error: `${where}: ${v.error} Nothing was imported.` };
    if (opts.builtInIds.has(v.recipe.id)) {
      return { ok: false, error: `${where}: "${v.recipe.id}" is the id of a built-in recipe - give it a different id. Nothing was imported.` };
    }
    if (ids.has(v.recipe.id)) return { ok: false, error: `${where}: the id "${v.recipe.id}" appears twice. Nothing was imported.` };
    if (v.recipe.slash) {
      if (aliases.has(v.recipe.slash)) {
        return { ok: false, error: `${where}: /${v.recipe.slash} is used by two recipes in this file. Nothing was imported.` };
      }
      aliases.add(v.recipe.slash);
    }
    ids.add(v.recipe.id);
    out.push(v.recipe);
  }
  return { ok: true, recipes: out };
}

/** Export format: versioned so a later import can tell it apart. */
export function exportRecipes(recipes: Recipe[]): string {
  const clean = recipes.map((r) => {
    const { builtIn: _builtIn, ...rest } = r;
    return rest;
  });
  return JSON.stringify({ format: "vegaduta-recipes", version: 1, recipes: clean }, null, 2);
}

/** "My review checklist!" -> "my-review-checklist". */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "recipe";
}

/** A new id for a personal recipe, unique against `taken`. */
export function newRecipeId(name: string, taken: ReadonlySet<string>): string {
  const base = `my-${slugify(name)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${taken.size + 1}`;
}

// --- the person's own recipes (local, guarded storage) -----------------------------------

export const USER_RECIPES_KEY = "vegaduta.chat.recipes.v1";

export class UserRecipeStore {
  private recipes: Recipe[] = [];
  persistent = true;

  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly builtInCommands: ReadonlySet<string>
  ) {
    this.load();
  }

  private load(): void {
    if (!this.storage) {
      this.persistent = false;
      return;
    }
    try {
      const raw = this.storage.getItem(USER_RECIPES_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      // Storage is re-validated too: it is only as trustworthy as whatever
      // else can write to this origin's localStorage.
      const seen = new Set<string>();
      for (const item of parsed) {
        const v = validateRecipe(item, { builtInCommands: this.builtInCommands });
        if (v.ok && !seen.has(v.recipe.id)) {
          seen.add(v.recipe.id);
          this.recipes.push(v.recipe);
        }
      }
    } catch {
      this.recipes = [];
    }
  }

  private save(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(USER_RECIPES_KEY, JSON.stringify(this.recipes));
      this.persistent = true;
      return true;
    } catch {
      this.persistent = false;
      return false;
    }
  }

  list(): Recipe[] {
    return this.recipes.map((r) => ({ ...r }));
  }

  get(id: string): Recipe | undefined {
    return this.recipes.find((r) => r.id === id);
  }

  /** Insert or replace by id. The caller validates first. */
  upsert(recipe: Recipe): void {
    const clean = { ...recipe, builtIn: false };
    const idx = this.recipes.findIndex((r) => r.id === recipe.id);
    if (idx >= 0) this.recipes[idx] = clean;
    else this.recipes.push(clean);
    this.save();
  }

  delete(id: string): void {
    this.recipes = this.recipes.filter((r) => r.id !== id);
    this.save();
  }

  /** Add imported recipes; same-id personal recipes are replaced. Returns
   * how many were added and replaced. */
  importAll(recipes: Recipe[]): { added: number; replaced: number } {
    let added = 0;
    let replaced = 0;
    for (const r of recipes) {
      if (this.get(r.id)) replaced += 1;
      else added += 1;
      const idx = this.recipes.findIndex((x) => x.id === r.id);
      if (idx >= 0) this.recipes[idx] = { ...r, builtIn: false };
      else this.recipes.push({ ...r, builtIn: false });
    }
    this.save();
    return { added, replaced };
  }
}

// --- small persisted preferences ---------------------------------------------------------

export const PREFS_KEY = "vegaduta.chat.prefs.v1";

export interface ChatPrefs {
  /** null until the person picks (or skips) on first run. */
  role: Role | null;
  /** The first-run role step has been answered or skipped. */
  onboarded: boolean;
  privateMode: boolean;
}

export function loadPrefs(storage: KeyValueStorage | null): ChatPrefs {
  const fallback: ChatPrefs = { role: null, onboarded: false, privateMode: false };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const p: unknown = JSON.parse(raw);
    if (!isPlainObject(p)) return fallback;
    return {
      role: typeof p.role === "string" && ROLE_IDS.has(p.role) ? (p.role as Role) : null,
      onboarded: p.onboarded === true,
      privateMode: p.privateMode === true,
    };
  } catch {
    return fallback;
  }
}

export function savePrefs(storage: KeyValueStorage | null, prefs: ChatPrefs): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

// --- built-in feature cards (not recipes: they have their own flows) ------------------------

export interface FeatureCard {
  id: "code-tour" | "ask-team";
  name: string;
  description: string;
  phase: SdlcPhase;
  roles: Role[];
  slash: string;
}

export const FEATURE_CARDS: FeatureCard[] = [
  {
    id: "code-tour",
    name: "Code Tour",
    description: "A guided walk through the current file - each stop jumps to its lines.",
    phase: "build",
    roles: ["developer", "reviewer", "tester", "architect"],
    slash: "tour",
  },
  {
    id: "ask-team",
    name: "Ask the team",
    description: "Search your team's knowledge base and get an answer that cites its sources.",
    phase: "plan",
    roles: ["product", "developer", "architect", "tester", "reviewer", "devops"],
    slash: "ask-team",
  },
];
