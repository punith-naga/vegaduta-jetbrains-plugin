// Pure helpers for ui.reveal (Code Tour): where the file is, and which lines
// to select. No platform API, so plain JUnit covers them (RevealTargetTest);
// HostEditorOps.reveal does the EDT work.

package ai.vegaduta.ide.context

import java.io.IOException
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.nio.file.Paths

/** Result of [resolveRevealPath]: the file, or the reason it is refused. */
sealed class RevealPath {
    data class Inside(val path: Path) : RevealPath()
    data class Refused(val reason: String) : RevealPath()
}

/**
 * Resolves the webview's `path` (project-relative, as IdeContextCollector
 * labelled a ContextItem - or an absolute path) against the project root and
 * refuses anything that is not inside it:
 *  - `..` segments that climb out, absolute paths elsewhere, other drives/UNC;
 *  - a symlink inside the project that points outside it (judged by the real
 *    path when the file exists);
 *  - NUL bytes and anything the file system cannot parse.
 * The webview's text comes from a model's answer, so it is untrusted input.
 */
fun resolveRevealPath(projectRoot: Path, requested: String): RevealPath {
    val raw = requested.trim()
    if (raw.isEmpty()) return RevealPath.Refused("No file path was given.")
    if (raw.indexOf('\u0000') >= 0) return RevealPath.Refused("The file path is not valid.")
    val base = projectRoot.toAbsolutePath().normalize()
    val candidate = try {
        Paths.get(raw.replace('\\', '/'))
    } catch (_: InvalidPathException) {
        return RevealPath.Refused("The file path is not valid: $raw")
    }
    val resolved = try {
        (if (candidate.isAbsolute) candidate else base.resolve(candidate)).toAbsolutePath().normalize()
    } catch (_: InvalidPathException) {
        return RevealPath.Refused("The file path is not valid: $raw")
    }
    if (resolved == base || !resolved.startsWith(base)) {
        return RevealPath.Refused("$raw is outside this project, so it was not opened.")
    }
    if (Files.exists(resolved)) {
        val inside = try {
            resolved.toRealPath().startsWith(base.toRealPath())
        } catch (_: IOException) {
            false
        }
        if (!inside) return RevealPath.Refused("$raw points outside this project, so it was not opened.")
    }
    return RevealPath.Inside(resolved)
}

/**
 * Turns the protocol's 1-based inclusive [startLine]..[endLine] into a 0-based
 * inclusive line pair clamped to a document of [lineCount] lines. A reversed
 * range is swapped; lines past the end land on the last line. Null when the
 * document is empty or the numbers are not positive.
 */
fun revealLineRange(startLine: Int, endLine: Int, lineCount: Int): Pair<Int, Int>? {
    if (lineCount <= 0 || startLine < 1 || endLine < 1) return null
    val lo = minOf(startLine, endLine)
    val hi = maxOf(startLine, endLine)
    val last = lineCount - 1
    return Pair((lo - 1).coerceAtMost(last), (hi - 1).coerceAtMost(last))
}
