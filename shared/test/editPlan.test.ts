// The edit-planning rules a host must not get wrong: uniqueness of old_text,
// and what happens when the file changes between the model reading it and the
// user approving the diff. The second one is the reason this module exists -
// applying a remembered offset to text that has moved writes the right code
// into the wrong place.

import { describe, expect, it } from "vitest";
import {
  describeChange,
  lineAt,
  planEdit,
  recheckEdit,
  summariseChange,
} from "../src/agent/editPlan";

const FILE = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");

describe("planEdit", () => {
  it("splices a unique match and reports its 1-based line", () => {
    const plan = planEdit(FILE, "const b = 2;", "const b = 22;");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.line).toBe(2);
    expect(plan.updated).toBe(["const a = 1;", "const b = 22;", "const c = 3;", ""].join("\n"));
  });

  it("refuses an old_text that occurs twice rather than picking the first", () => {
    const twice = "x();\ny();\nx();\n";
    expect(planEdit(twice, "x();", "z();")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("refuses an old_text that is absent, and an empty one", () => {
    expect(planEdit(FILE, "const d = 4;", "")).toEqual({ ok: false, reason: "not-found" });
    expect(planEdit(FILE, "", "anything")).toEqual({ ok: false, reason: "empty-old-text" });
  });

  it("matches exactly, including indentation", () => {
    const indented = "function f() {\n  return 1;\n}\n";
    expect(planEdit(indented, "return 1;", "return 2;").ok).toBe(true);
    expect(planEdit(indented, "    return 1;", "return 2;")).toEqual({ ok: false, reason: "not-found" });
  });

  it("counts CRLF lines the same as LF lines", () => {
    const crlf = "a\r\nb\r\nc\r\n";
    const plan = planEdit(crlf, "c", "C");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.line).toBe(3);
    expect(plan.updated).toBe("a\r\nb\r\nC\r\n");
  });

  it("does not lose text around a multi-line replacement", () => {
    const plan = planEdit(FILE, "const b = 2;\nconst c = 3;", "const b = 2;");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.updated).toBe("const a = 1;\nconst b = 2;\n");
  });
});

describe("lineAt", () => {
  it("is 1-based and clamps a negative offset", () => {
    expect(lineAt(FILE, 0)).toBe(1);
    expect(lineAt(FILE, FILE.indexOf("const c"))).toBe(3);
    expect(lineAt(FILE, -5)).toBe(1);
  });
});

describe("recheckEdit", () => {
  it("reports an untouched file as unmoved", () => {
    const result = recheckEdit(FILE, FILE, "const b = 2;", "const b = 22;");
    expect(result.state).toBe("unmoved");
  });

  it("re-anchors when the file moved but the snippet still names one place", () => {
    // Someone (or the agent's own run_command) prepended a line while the diff
    // was on screen. The hunk is unchanged; only its position moved.
    const fresh = `// added while you were reading\n${FILE}`;
    const result = recheckEdit(FILE, fresh, "const b = 2;", "const b = 22;");
    expect(result.state).toBe("reanchored");
    if (result.state === "conflict") return;
    expect(result.line).toBe(3);
    expect(result.updated).toBe(
      "// added while you were reading\nconst a = 1;\nconst b = 22;\nconst c = 3;\n"
    );
    // The point of the whole exercise: the stale splice would have corrupted
    // the file, so the re-anchored result must differ from it.
    const stale = planEdit(FILE, "const b = 2;", "const b = 22;");
    expect(stale.ok && stale.updated).not.toBe(result.updated);
  });

  it("conflicts when the snippet is gone", () => {
    const fresh = FILE.replace("const b = 2;", "const b = 99;");
    expect(recheckEdit(FILE, fresh, "const b = 2;", "const b = 22;")).toEqual({
      state: "conflict",
      reason: "not-found",
    });
  });

  it("conflicts when the snippet has been duplicated", () => {
    const fresh = `${FILE}const b = 2;\n`;
    expect(recheckEdit(FILE, fresh, "const b = 2;", "const b = 22;")).toEqual({
      state: "conflict",
      reason: "ambiguous",
    });
  });
});

describe("summariseChange", () => {
  it("counts only the changed middle, and reports where it starts", () => {
    const before = "a\nb\nc\nd\n";
    const after = "a\nB1\nB2\nc\nd\n";
    expect(summariseChange(before, after)).toEqual({
      added: 2,
      removed: 1,
      firstChangedLine: 2,
    });
  });

  it("does not blame line 1 for a change at the end of a file", () => {
    const before = "1\n2\n3\n4\n5\n";
    const after = "1\n2\n3\n4\n5x\n";
    expect(summariseChange(before, after).firstChangedLine).toBe(5);
  });

  it("reports pure insertion and pure deletion", () => {
    expect(summariseChange("a\nc\n", "a\nb\nc\n")).toEqual({ added: 1, removed: 0, firstChangedLine: 2 });
    expect(summariseChange("a\nb\nc\n", "a\nc\n")).toEqual({ added: 0, removed: 1, firstChangedLine: 2 });
  });

  it("reports identical text as no change", () => {
    expect(summariseChange(FILE, FILE)).toEqual({ added: 0, removed: 0, firstChangedLine: 0 });
    expect(describeChange(summariseChange(FILE, FILE))).toBe("no change");
  });

  it("treats a new file as all-added", () => {
    expect(describeChange(summariseChange("", "a\nb\n"))).toBe("+2 / -0 line(s), from line 1");
  });
});
