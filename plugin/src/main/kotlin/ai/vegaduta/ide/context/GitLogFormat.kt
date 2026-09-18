// Pure half of the "gitlog" context kind (protocol.ts ContextKind "gitlog":
// recent commit subjects + bodies, for commit messages in the team's own
// style, release notes and standups). IdeContextCollector runs the git
// process; everything here is plain-JUnit tested (GitLogFormatTest).

package ai.vegaduta.ide.context

import java.io.File

/** protocol.ts: "git log -n 30". */
const val GIT_LOG_MAX_COMMITS = 30

/** Per-commit body cap, so one huge merge message cannot crowd out the rest. */
const val GIT_LOG_MAX_BODY_LINES = 20
const val GIT_LOG_MAX_BODY_CHARS = 1_200

private const val RECORD_SEP = '\u001e'
private const val FIELD_SEP = '\u001f'

/** The git arguments (after "git") that produce what [parseGitLog] reads.
 * Author NAME only - no e-mail addresses go into a prompt. */
val GIT_LOG_ARGS: List<String> = listOf(
    "log",
    "-n", GIT_LOG_MAX_COMMITS.toString(),
    "--no-color",
    "--date=short",
    "--format=%x1e%h%x1f%ad%x1f%an%x1f%s%x1f%b",
)

data class GitCommit(val hash: String, val date: String, val author: String, val subject: String, val body: String)

/** Parses `git log` output produced with [GIT_LOG_ARGS]. Malformed records
 * are skipped; never more than [GIT_LOG_MAX_COMMITS]. */
fun parseGitLog(output: String): List<GitCommit> =
    output.split(RECORD_SEP)
        .asSequence()
        .map { it.trim('\n', '\r') }
        .filter { it.isNotBlank() }
        .mapNotNull { record ->
            val f = record.split(FIELD_SEP, limit = 5)
            if (f.size < 4 || f[0].isBlank()) return@mapNotNull null
            GitCommit(
                hash = f[0].trim(),
                date = f[1].trim(),
                author = f[2].trim(),
                subject = f[3].trim(),
                body = f.getOrElse(4) { "" }.replace("\r\n", "\n").trim(),
            )
        }
        .take(GIT_LOG_MAX_COMMITS)
        .toList()

/** Caps one commit body; the second value is true when it was cut. */
fun capCommitBody(body: String): Pair<String, Boolean> {
    val lines = body.split('\n')
    var cut = false
    var kept = lines
    if (lines.size > GIT_LOG_MAX_BODY_LINES) {
        kept = lines.take(GIT_LOG_MAX_BODY_LINES)
        cut = true
    }
    var text = kept.joinToString("\n")
    if (text.length > GIT_LOG_MAX_BODY_CHARS) {
        text = truncateForContext(text, GIT_LOG_MAX_BODY_CHARS).first
        cut = true
    }
    return Pair(text, cut)
}

/** Renders commits newest-first as the item text, truncated to the shared
 * per-item ceiling. Second value: whether anything was cut. */
fun formatGitLog(commits: List<GitCommit>, max: Int = CONTEXT_ITEM_MAX_CHARS): Pair<String, Boolean> {
    val out = StringBuilder()
    out.append("The ").append(commits.size).append(if (commits.size == 1) " most recent commit" else " most recent commits")
        .append(" in this repository, newest first:\n")
    var bodyCut = false
    for (c in commits) {
        out.append('\n')
        out.append(c.hash).append("  ").append(c.date).append("  ").append(c.author).append('\n')
        out.append(c.subject).append('\n')
        if (c.body.isNotEmpty()) {
            val (body, cut) = capCommitBody(c.body)
            bodyCut = bodyCut || cut
            out.append('\n').append(body).append('\n')
            if (cut) out.append("[commit message shortened]\n")
        }
    }
    val (text, cut) = truncateForContext(out.toString(), max)
    return Pair(text, cut || bodyCut)
}

fun gitLogLabel(count: Int): String = "Recent commits ($count)"

/** Walks up from [start] to the nearest directory holding `.git` (a folder,
 * or a file for worktrees and submodules). Null outside any repository. */
fun findGitRoot(start: File): File? {
    var dir: File? = start.absoluteFile
    while (dir != null) {
        if (File(dir, ".git").exists()) return dir
        dir = dir.parentFile
    }
    return null
}
