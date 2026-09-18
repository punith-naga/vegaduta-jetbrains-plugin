// The canonical coding toolset, described once and implemented per host. Ported
// from clients/shared/src/agent/codingTools.ts - the two must stay identical,
// because a model prompted for one and handed the other silently degrades.
//
// Six tools, not sixty. Every extra tool costs context on every single turn and
// gives a small local model one more thing to choose wrongly - and the free tier
// here is explicitly small local models. This set is the minimum that can
// actually finish a task: look around, read, search, create, edit, verify.
//
// EDIT vs WRITE is the important one. `code-intel` server-side can only write
// whole files, which burns tokens proportional to file size and loses unrelated
// edits made while the model was thinking. `edit_file` does an exact-string
// replacement instead, so a three-line fix costs three lines.

package ai.vegaduta.ide.agent

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

const val LIST_DIR = "list_dir"
const val READ_FILE = "read_file"
const val SEARCH_TEXT = "search_text"
const val WRITE_FILE = "write_file"
const val EDIT_FILE = "edit_file"
const val RUN_COMMAND = "run_command"

private fun schema(required: List<String>, properties: JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject {
    put("type", "object")
    putJsonObject("properties", properties)
    putJsonArray("required") { required.forEach { add(it) } }
}

private fun JsonObjectBuilder.property(name: String, type: String, description: String) {
    putJsonObject(name) {
        put("type", type)
        put("description", description)
    }
}

/** Every path argument is workspace-relative and POSIX-separated. Hosts resolve
 * and MUST reject anything that escapes the workspace root. */
val CODING_TOOL_SPECS: List<ToolSpec> = listOf(
    ToolSpec(
        name = LIST_DIR,
        description = "List files and directories at a workspace-relative path. Use this first to orient " +
            "yourself; do not guess file paths.",
        mutating = false,
        parameters = schema(listOf("path")) {
            property("path", "string", "Workspace-relative directory path. Use \".\" for the root.")
        },
    ),
    ToolSpec(
        name = READ_FILE,
        description = "Read a file's contents. Returns the file with 1-based line numbers prefixed so you can " +
            "refer to lines precisely. Large files are truncated - pass start_line/end_line to page.",
        mutating = false,
        parameters = schema(listOf("path")) {
            property("path", "string", "Workspace-relative file path.")
            property("start_line", "integer", "First line to read, 1-based. Optional.")
            property("end_line", "integer", "Last line to read, inclusive. Optional.")
        },
    ),
    ToolSpec(
        name = SEARCH_TEXT,
        description = "Search the workspace for a literal string or regular expression and return matching " +
            "file paths with line numbers. Far cheaper than reading files to find something.",
        mutating = false,
        parameters = schema(listOf("query")) {
            property("query", "string", "Literal text, or a regular expression when is_regex is true.")
            property("is_regex", "boolean", "Treat query as a regular expression. Default false.")
            property("include", "string", "Optional glob limiting the search, e.g. \"src/**/*.ts\".")
        },
    ),
    ToolSpec(
        name = WRITE_FILE,
        description = "Create a new file, or replace an existing file's entire contents. Prefer edit_file for " +
            "changes to an existing file - a full rewrite risks discarding code you did not read.",
        mutating = true,
        parameters = schema(listOf("path", "content")) {
            property("path", "string", "Workspace-relative file path.")
            property("content", "string", "The complete new contents of the file.")
        },
    ),
    ToolSpec(
        name = EDIT_FILE,
        description = "Replace an exact snippet of an existing file. old_text must appear EXACTLY once, " +
            "whitespace and indentation included - include enough surrounding context to make it " +
            "unique. This is the preferred way to change code.",
        mutating = true,
        parameters = schema(listOf("path", "old_text", "new_text")) {
            property("path", "string", "Workspace-relative file path.")
            property("old_text", "string", "Exact text to replace. Must occur exactly once.")
            property("new_text", "string", "Replacement text.")
        },
    ),
    ToolSpec(
        name = RUN_COMMAND,
        description = "Run a shell command in the workspace and return its stdout, stderr and exit code. Use " +
            "this to verify your work - run the tests, the type checker, the linter, the build. Do " +
            "not claim something works without running it.",
        mutating = true,
        parameters = schema(listOf("command")) {
            property("command", "string", "The command line to run.")
            property("cwd", "string", "Workspace-relative working directory. Optional.")
        },
    ),
)

data class SystemPromptContext(
    /** Absolute or display path of the workspace root, for the model's orientation. */
    val workspaceName: String,
    /** Project conventions the host found (AGENTS.md, CLAUDE.md, README excerpt). */
    val projectNotes: String? = null,
    /** File the user had open, if any. */
    val activeFile: String? = null,
)

/**
 * The system prompt. Written for small local models: short, concrete, and heavy
 * on what NOT to do, because that is where 7B-class models actually fail -
 * inventing file paths, rewriting whole files, and declaring success without
 * running anything.
 */
fun buildCodingSystemPrompt(context: SystemPromptContext): String {
    val lines = mutableListOf(
        "You are a coding agent working directly in a user's workspace. You have tools that read,",
        "search, edit and run commands on their real machine. Changes you make are real.",
        "",
        "Workspace: ${context.workspaceName}",
    )
    if (!context.activeFile.isNullOrBlank()) {
        lines += "The user currently has open: ${context.activeFile}"
    }
    lines += listOf(
        "",
        "How to work:",
        "1. Look before you edit. List directories and read the actual files. Never guess a path,",
        "   an import, a function signature or a test framework - check.",
        "2. Prefer edit_file over write_file. Make the smallest change that does the job.",
        "3. Verify. After editing, run the project's tests or type checker with run_command and",
        "   read the output. If you did not run anything, say so plainly rather than implying you did.",
        "4. When you are finished, reply with no tool calls: say what you changed, in which files,",
        "   and what you verified. Report failures honestly - a passing summary over failing tests",
        "   is worse than no summary.",
        "",
        "Limits: match the surrounding code's style rather than your own. Do not add dependencies,",
        "rename things, or reformat files you were not asked to touch. If the task is ambiguous in a",
        "way that changes the result, stop and ask instead of guessing.",
    )
    if (!context.projectNotes.isNullOrBlank()) {
        lines += listOf("", "Project conventions (from the repository, follow these):", context.projectNotes.trim())
    }
    return lines.joinToString("\n")
}
