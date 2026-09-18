package ai.vegaduta.ide.context

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GitLogFormatTest {

    private fun record(hash: String, date: String, author: String, subject: String, body: String) =
        "\u001e$hash\u001f$date\u001f$author\u001f$subject\u001f$body\n"

    @Test
    fun `git arguments ask for 30 commits and never for e-mail addresses`() {
        assertEquals("log", GIT_LOG_ARGS.first())
        val n = GIT_LOG_ARGS.indexOf("-n")
        assertEquals("30", GIT_LOG_ARGS[n + 1])
        val format = GIT_LOG_ARGS.first { it.startsWith("--format=") }
        assertFalse(format.contains("%ae") || format.contains("%ce"), format)
        assertTrue("--no-color" in GIT_LOG_ARGS)
    }

    @Test
    fun `parses subjects, bodies and CRLF bodies`() {
        val out = record("a1b2c3d", "2026-09-18", "Ada", "feat: add thing", "Why it matters.\r\n\r\nRefs #12\n") +
            record("e4f5a6b", "2026-09-17", "Lin", "fix: typo", "")
        val commits = parseGitLog(out)
        assertEquals(2, commits.size)
        assertEquals(GitCommit("a1b2c3d", "2026-09-18", "Ada", "feat: add thing", "Why it matters.\n\nRefs #12"), commits[0])
        assertEquals("", commits[1].body)
    }

    @Test
    fun `a body containing the field separator stays in the body`() {
        // Body may itself contain \u001f (limit = 5 keeps it in the body).
        val out = record("abc", "2026-01-01", "X", "subject", "body\u001fstill body")
        assertEquals("body\u001fstill body", parseGitLog(out).single().body)
    }

    @Test
    fun `malformed records and empty output are skipped`() {
        assertEquals(emptyList(), parseGitLog(""))
        assertEquals(emptyList(), parseGitLog("\u001e\n\u001eonly-one-field\n"))
    }

    @Test
    fun `never more than 30 commits`() {
        val out = (1..40).joinToString("") { record("h$it", "2026-01-01", "A", "s$it", "") }
        val commits = parseGitLog(out)
        assertEquals(GIT_LOG_MAX_COMMITS, commits.size)
        assertEquals("h1", commits.first().hash)
    }

    @Test
    fun `formats newest first with hash, date, author, subject and body`() {
        val (text, cut) = formatGitLog(
            listOf(
                GitCommit("a1b2c3d", "2026-09-18", "Ada", "feat: add thing", "Why it matters."),
                GitCommit("e4f5a6b", "2026-09-17", "Lin", "fix: typo", ""),
            )
        )
        assertFalse(cut)
        assertTrue(text.startsWith("The 2 most recent commits in this repository, newest first:\n"))
        assertTrue(text.contains("a1b2c3d  2026-09-18  Ada\nfeat: add thing\n\nWhy it matters.\n"))
        assertTrue(text.indexOf("a1b2c3d") < text.indexOf("e4f5a6b"))
        assertEquals("Recent commits (2)", gitLogLabel(2))
    }

    @Test
    fun `a long commit body is capped by lines and marked`() {
        val body = (1..50).joinToString("\n") { "line $it" }
        val (capped, cut) = capCommitBody(body)
        assertTrue(cut)
        assertEquals(GIT_LOG_MAX_BODY_LINES, capped.lines().size)
        val (text, textCut) = formatGitLog(listOf(GitCommit("h", "d", "a", "s", body)))
        assertTrue(textCut, "a shortened body flags the item as truncated")
        assertTrue(text.contains("[commit message shortened]"))
    }

    @Test
    fun `a long single-line commit body is capped by characters`() {
        val (capped, cut) = capCommitBody("x".repeat(5_000))
        assertTrue(cut)
        assertEquals(GIT_LOG_MAX_BODY_CHARS, capped.length)
        assertEquals(Pair("short", false), capCommitBody("short"))
    }

    @Test
    fun `the whole item is truncated to the shared ceiling`() {
        val commits = (1..30).map { GitCommit("h$it", "2026-01-01", "A", "s".repeat(2_000), "") }
        val (text, cut) = formatGitLog(commits)
        assertTrue(cut)
        assertEquals(CONTEXT_ITEM_MAX_CHARS, text.length)
    }

    @Test
    fun `finds the nearest git root walking up, and none outside a repository`() {
        val tmp = Files.createTempDirectory("vegaduta-gitroot").toFile()
        try {
            val repo = File(tmp, "repo").apply { mkdirs() }
            File(repo, ".git").mkdirs()
            val deep = File(repo, "a/b/c").apply { mkdirs() }
            assertEquals(repo.absoluteFile, findGitRoot(deep))
            assertEquals(repo.absoluteFile, findGitRoot(repo))

            // Worktrees and submodules have a .git FILE.
            val worktree = File(tmp, "wt").apply { mkdirs() }
            File(worktree, ".git").writeText("gitdir: ../repo/.git/worktrees/wt\n")
            assertEquals(worktree.absoluteFile, findGitRoot(File(worktree, "x").apply { mkdirs() }))

            // tmp itself is (almost always) not inside a repository.
            val plain = File(tmp, "plain").apply { mkdirs() }
            val found = findGitRoot(plain)
            if (found != null) assertFalse(found.startsWith(tmp), "must not invent a root inside tmp")
            else assertNull(found)
        } finally {
            tmp.deleteRecursively()
        }
    }
}
