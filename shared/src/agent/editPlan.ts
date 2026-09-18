// The pure half of an exact-string file edit: where the snippet is, what the
// change amounts to in lines, and - the part that actually matters - what to do
// when the file moved between the model reading it and the user approving it.
//
// clients/vscode/src/commands/localAction.ts hit this hazard first, against a
// live TextDocument: generation plus a human decision is a long time, and
// applying a remembered position afterwards writes the right text into the
// wrong place. It answers by refusing. An exact-string edit can do better,
// because the snippet identifies its own location: the question is not "did
// anything change?" but "does old_text still name exactly one place?".
//
// No vscode import on purpose - this is the part worth testing, and a host API
// in here would make it untestable (clients/shared/test/editPlan.test.ts).

export type EditFailureReason = "empty-old-text" | "not-found" | "ambiguous";

export interface EditSplice {
  /** Character offset of old_text in the text it was matched against. */
  offset: number;
  /** 1-based line number of that offset. */
  line: number;
  /** The whole file, with the replacement applied. */
  updated: string;
}

export type EditPlan = ({ ok: true } & EditSplice) | { ok: false; reason: EditFailureReason };

/** 1-based line number containing `offset`. */
export function lineAt(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

/**
 * Locate old_text and compute the resulting file. Uniqueness is a requirement,
 * not a preference: a snippet that matches twice cannot be re-anchored later,
 * and picking the first match would make the edit silently position-dependent.
 */
export function planEdit(text: string, oldText: string, newText: string): EditPlan {
  if (oldText === "") return { ok: false, reason: "empty-old-text" };
  const offset = text.indexOf(oldText);
  if (offset < 0) return { ok: false, reason: "not-found" };
  if (text.indexOf(oldText, offset + oldText.length) >= 0) return { ok: false, reason: "ambiguous" };
  return {
    ok: true,
    offset,
    line: lineAt(text, offset),
    updated: text.slice(0, offset) + newText + text.slice(offset + oldText.length),
  };
}

export type EditRecheck =
  | ({ state: "unmoved" | "reanchored" } & EditSplice)
  | { state: "conflict"; reason: "not-found" | "ambiguous" };

/**
 * Decide whether a planned edit may still be applied to the file as it is NOW.
 *
 * "reanchored" is safe to apply even though the user approved a diff of the
 * older text: the replaced region is byte-identical to the one they saw
 * replaced, only the untouched parts of the file around it moved. "conflict"
 * means the snippet no longer names one place, and there is no honest way to
 * guess where the user's approval pointed - the caller must write nothing.
 */
export function recheckEdit(
  snapshot: string,
  fresh: string,
  oldText: string,
  newText: string
): EditRecheck {
  const plan = planEdit(fresh, oldText, newText);
  if (!plan.ok) {
    return { state: "conflict", reason: plan.reason === "ambiguous" ? "ambiguous" : "not-found" };
  }
  return {
    state: snapshot === fresh ? "unmoved" : "reanchored",
    offset: plan.offset,
    line: plan.line,
    updated: plan.updated,
  };
}

export interface ChangeSummary {
  added: number;
  removed: number;
  /** 1-based line where the two versions first differ; 0 when identical. */
  firstChangedLine: number;
}

/**
 * Line counts for the approval prompt. Common head and tail are trimmed, so an
 * edit near the end of a large file reports "from line 900", not "from line 1".
 * This is a summary for a notification, not a diff algorithm - the diff editor
 * next to it does the real work.
 */
export function summariseChange(before: string, after: string): ChangeSummary {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const removed = endA - start;
  const added = endB - start;
  return { added, removed, firstChangedLine: added === 0 && removed === 0 ? 0 : start + 1 };
}

/** One line of prose for an approval prompt. */
export function describeChange(summary: ChangeSummary): string {
  if (summary.added === 0 && summary.removed === 0) return "no change";
  return `+${summary.added} / -${summary.removed} line(s), from line ${summary.firstChangedLine}`;
}
