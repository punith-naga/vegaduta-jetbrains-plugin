// Pure helpers for the host side of the context-attachment contract
// (clients/shared/src/webview/protocol.ts: ContextItem, CONTEXT_ITEM_MAX_CHARS).
// Nothing here touches the IntelliJ Platform, so it is covered by plain JUnit
// (src/test/kotlin/ai/vegaduta/ide/context/ContextFormatTest.kt).

package ai.vegaduta.ide.context

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Mirrors CONTEXT_ITEM_MAX_CHARS in protocol.ts - four hosts agree on one ceiling. */
const val CONTEXT_ITEM_MAX_CHARS = 24_000

/** The context kinds this host can supply (init.capabilities.context).
 * "page" and "pageElements" are Chrome's; an IDE has no page. "terminal" is
 * left out on purpose: the IntelliJ Platform has no public, stable API for the
 * terminal's selection in the 242+ range this plugin supports. */
val JETBRAINS_CONTEXT_KINDS = listOf("file", "selection", "diff", "diagnostics", "gitlog")

data class ContextItem(
    val kind: String,
    val label: String,
    val text: String,
    val languageId: String? = null,
    val truncated: Boolean = false,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", kind)
        put("label", label)
        put("text", text)
        languageId?.let { put("languageId", it) }
        if (truncated) put("truncated", true)
    }
}

data class MissingContext(val kind: String, val reason: String) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", kind)
        put("reason", reason)
    }
}

/** Builds an item, truncating to [max] and flagging it - the webview never
 * receives an unbounded file. Never splits a surrogate pair. */
fun contextItem(kind: String, label: String, text: String, languageId: String? = null, max: Int = CONTEXT_ITEM_MAX_CHARS): ContextItem {
    val (body, cut) = truncateForContext(text, max)
    return ContextItem(kind, label, body, languageId, cut)
}

fun truncateForContext(text: String, max: Int = CONTEXT_ITEM_MAX_CHARS): Pair<String, Boolean> {
    if (text.length <= max) return Pair(text, false)
    var end = max
    if (end > 0 && Character.isHighSurrogate(text[end - 1])) end -= 1
    return Pair(text.substring(0, end), true)
}

fun lineCount(text: String): Int = if (text.isEmpty()) 0 else text.count { it == '\n' } + if (text.endsWith('\n')) 0 else 1

fun selectionLabel(text: String, fileName: String?): String {
    val lines = lineCount(text)
    val noun = if (lines == 1) "line" else "lines"
    return if (fileName != null) "Selection in $fileName ($lines $noun)" else "Selection ($lines $noun)"
}

/** A changed line range, 0-based and end-exclusive on both sides - the same
 * shape as com.intellij.diff.fragments.LineFragment, minus the platform. */
data class LineRange(val start1: Int, val end1: Int, val start2: Int, val end2: Int)

/** Splits into lines. Indices match IntelliJ's LineFragment for every real
 * line; the phantom empty line after a final newline is dropped (unifiedDiff
 * clamps ranges, so a fragment touching it is still safe). */
fun splitLines(text: String?): List<String> {
    if (text.isNullOrEmpty()) return emptyList()
    val lines = text.split('\n').map { it.removeSuffix("\r") }
    return if (text.endsWith('\n')) lines.dropLast(1) else lines
}

/**
 * Formats one file's changes as a unified diff (`git diff` shape) with [context]
 * lines around each change. [before] null = added file, [after] null = deleted.
 * [ranges] are the changed line ranges; pass null for an added or deleted
 * file and the whole file is one range.
 */
fun unifiedDiff(path: String, before: String?, after: String?, ranges: List<LineRange>?, context: Int = 3): String {
    val a = splitLines(before)
    val b = splitLines(after)
    val fragments = (ranges ?: listOf(LineRange(0, a.size, 0, b.size))).map {
        LineRange(
            it.start1.coerceIn(0, a.size), it.end1.coerceIn(0, a.size),
            it.start2.coerceIn(0, b.size), it.end2.coerceIn(0, b.size),
        )
    }
    val out = StringBuilder()
    out.append("--- ").append(if (before == null) "/dev/null" else "a/$path").append('\n')
    out.append("+++ ").append(if (after == null) "/dev/null" else "b/$path").append('\n')
    val sorted = fragments.filter { it.end1 > it.start1 || it.end2 > it.start2 }.sortedBy { it.start1 }
    if (sorted.isEmpty()) return out.toString()

    // Group fragments whose context windows touch into one hunk.
    val hunks = mutableListOf<MutableList<LineRange>>()
    for (f in sorted) {
        val last = hunks.lastOrNull()?.last()
        if (last != null && f.start1 - context <= last.end1 + context) {
            hunks.last().add(f)
        } else {
            hunks.add(mutableListOf(f))
        }
    }
    for (hunk in hunks) {
        val first = hunk.first()
        val lastF = hunk.last()
        val lead = minOf(context, first.start1, first.start2)
        val hs1 = first.start1 - lead
        val hs2 = first.start2 - lead
        val trail = minOf(context, a.size - lastF.end1, b.size - lastF.end2)
        val he1 = lastF.end1 + trail
        val he2 = lastF.end2 + trail
        out.append("@@ -").append(hunkRange(hs1, he1)).append(" +").append(hunkRange(hs2, he2)).append(" @@\n")
        var pos1 = hs1
        for (f in hunk) {
            while (pos1 < f.start1) out.append(' ').append(a[pos1++]).append('\n')
            for (i in f.start1 until f.end1) out.append('-').append(a[i]).append('\n')
            for (i in f.start2 until f.end2) out.append('+').append(b[i]).append('\n')
            pos1 = f.end1
        }
        while (pos1 < he1) out.append(' ').append(a[pos1++]).append('\n')
    }
    return out.toString()
}

private fun hunkRange(start: Int, end: Int): String {
    val count = end - start
    return if (count == 0) "$start,0" else "${start + 1},$count"
}

/** Counts "diff --git" headers in `git diff` output. */
fun countGitDiffFiles(diff: String): Int = diff.lineSequence().count { it.startsWith("diff --git ") }

fun diffLabel(files: Int): String = "Working tree diff ($files ${if (files == 1) "file" else "files"})"

/** One formatted problem line for the diagnostics item. [line] is 0-based. */
fun formatProblem(severity: String, line: Int, message: String): String =
    "${severity.uppercase()} line ${line + 1}: ${message.trim().replace(Regex("\\s+"), " ")}"

fun diagnosticsLabel(count: Int, fileName: String): String =
    if (count == 0) "No problems in $fileName" else "$count ${if (count == 1) "problem" else "problems"} in $fileName"

/**
 * Maps a webview languageId (VS Code-style: "python", "typescriptreact") or an
 * IntelliJ file-type name lowercased ("kotlin", "javascript") to a file
 * extension for ui.newFile. Unknown ids that already look like an extension
 * ("py", "rs") pass through; anything else is plain text.
 */
fun extensionForLanguageId(languageId: String?): String {
    val id = languageId?.trim()?.lowercase().orEmpty()
    if (id.isEmpty()) return "txt"
    LANGUAGE_EXTENSIONS[id]?.let { return it }
    return if (id.length <= 5 && id.all { it.isLetterOrDigit() }) id else "txt"
}

private val LANGUAGE_EXTENSIONS = mapOf(
    "python" to "py",
    "javascript" to "js",
    "javascriptreact" to "jsx",
    "typescript" to "ts",
    "typescriptreact" to "tsx",
    "java" to "java",
    "kotlin" to "kt",
    "go" to "go",
    "golang" to "go",
    "rust" to "rs",
    "ruby" to "rb",
    "csharp" to "cs",
    "c#" to "cs",
    "cpp" to "cpp",
    "c++" to "cpp",
    "c" to "c",
    "shellscript" to "sh",
    "shell" to "sh",
    "bash" to "sh",
    "sh" to "sh",
    "powershell" to "ps1",
    "json" to "json",
    "yaml" to "yaml",
    "yml" to "yaml",
    "markdown" to "md",
    "html" to "html",
    "css" to "css",
    "scss" to "scss",
    "sql" to "sql",
    "xml" to "xml",
    "php" to "php",
    "swift" to "swift",
    "scala" to "scala",
    "dart" to "dart",
    "groovy" to "groovy",
    "toml" to "toml",
    "plaintext" to "txt",
    "text" to "txt",
)
