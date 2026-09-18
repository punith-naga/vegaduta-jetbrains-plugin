// The recipe contract - FIXED before two agents build against it in parallel:
// one writes the built-in SDLC library (library.ts), the other renders and
// runs recipes in the chat UI. Change it only together with both.
//
// A recipe is a named, reusable prompt plus what it needs to run: the context
// kinds it wants attached, who it is for, which SDLC phase it serves, and what
// to offer with the answer. Built-ins ship with the plugin; user recipes are
// the same shape with builtIn:false, stored locally and exportable as JSON.

import type { ContextKind } from "../../protocol";

export type SdlcPhase =
  | "plan"
  | "design"
  | "build"
  | "test"
  | "review"
  | "release"
  | "operate"
  | "automate";

export type Role = "developer" | "tester" | "reviewer" | "architect" | "product" | "devops";

export interface RecipeOutput {
  /** How the answer is shaped - lets the UI offer the right actions. */
  kind: "markdown" | "code" | "csv" | "json" | "mermaid";
  /** For code/csv/json: the languageId to open it with (ui.newFile). */
  languageId?: string;
  /** Offer "Open as new file" on the answer (host needs capabilities.newFile). */
  offerNewFile?: boolean;
  /** Offer "Use as commit message" (host needs capabilities.commitMessage). */
  offerCommitMessage?: boolean;
  /** Offer "Run a workflow with this" (needs sign-in and at least one workflow). */
  offerWorkflow?: boolean;
}

export interface Recipe {
  /** Stable kebab-case id, e.g. "story-to-acceptance-criteria". Never reuse. */
  id: string;
  /** Short UI label, e.g. "Acceptance criteria from a story". */
  name: string;
  /** One sentence: what it produces and for whom. */
  description: string;
  phase: SdlcPhase;
  /** Who it is for; the FIRST is the primary role it is filed under. */
  roles: Role[];
  /** Optional slash alias WITHOUT the slash, e.g. "ac". Must not collide with
   * the chat app's own commands. The authoritative list is
   * BUILT_IN_COMMAND_NAMES in ../commands.ts (explain fix tests docs review
   * commit summarize translate new clear models help tour ask-team toolkit, as
   * of 2026-09-18) - enforcement reads that list, so this comment can lag it,
   * but the code cannot. */
  slash?: string;
  /** Context kinds it wants. The chat app requests only those the host
   * declares in capabilities.context. */
  context: ContextKind[];
  /** True = pointless without at least one of `context` (e.g. a diff review).
   * The UI hides it when the host can supply none of them. */
  requiresContext?: boolean;
  /** The prompt. `{{input}}` is replaced by what the person typed after
   * picking the recipe (may be empty). Attachments are appended by the chat
   * app in its own delimited format - do NOT reference them positionally. */
  prompt: string;
  output?: RecipeOutput;
  /** Produces a usable answer on a small (1-3B) on-device model with a 4k
   * window. False for recipes that genuinely need a large hosted model. */
  localFriendly: boolean;
  builtIn: boolean;
}
