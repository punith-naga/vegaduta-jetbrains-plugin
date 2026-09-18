package ai.vegaduta.ide.context

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ContextFormatTest {

    @Test
    fun `short text is not truncated`() {
        val item = contextItem("file", "a.kt", "hello")
        assertEquals("hello", item.text)
        assertFalse(item.truncated)
        assertFalse(item.toJson().containsKey("truncated"))
    }

    @Test
    fun `text over the ceiling is cut to exactly the ceiling and flagged`() {
        val item = contextItem("file", "big.kt", "x".repeat(CONTEXT_ITEM_MAX_CHARS + 500))
        assertEquals(CONTEXT_ITEM_MAX_CHARS, item.text.length)
        assertTrue(item.truncated)
        assertEquals("true", item.toJson()["truncated"].toString())
    }

    @Test
    fun `the ceiling matches protocol ts`() {
        assertEquals(24_000, CONTEXT_ITEM_MAX_CHARS)
    }

    @Test
    fun `truncation never splits a surrogate pair`() {
        val emoji = "😀" // one code point, two chars
        val (text, cut) = truncateForContext("ab$emoji", 3)
        assertTrue(cut)
        assertEquals("ab", text)
    }

    @Test
    fun `selection label counts lines`() {
        assertEquals("Selection in A.kt (1 line)", selectionLabel("val x = 1", "A.kt"))
        assertEquals("Selection (3 lines)", selectionLabel("a\nb\nc\n", null))
    }

    @Test
    fun `unified diff of a one-line change has context and git-style header`() {
        val before = "one\ntwo\nthree\nfour\nfive\n"
        val after = "one\ntwo\nTHREE\nfour\nfive\n"
        val diff = unifiedDiff("src/a.txt", before, after, listOf(LineRange(2, 3, 2, 3)))
        assertEquals(
            "--- a/src/a.txt\n" +
                "+++ b/src/a.txt\n" +
                "@@ -1,5 +1,5 @@\n" +
                " one\n" +
                " two\n" +
                "-three\n" +
                "+THREE\n" +
                " four\n" +
                " five\n",
            diff,
        )
    }

    @Test
    fun `distant changes become separate hunks`() {
        val before = (1..20).joinToString("\n") { "l$it" } + "\n"
        val after = before.replace("l2\n", "L2\n").replace("l18\n", "L18\n")
        val diff = unifiedDiff("f", before, after, listOf(LineRange(1, 2, 1, 2), LineRange(17, 18, 17, 18)))
        assertEquals(2, diff.lines().count { it.startsWith("@@") })
        assertTrue(diff.contains("@@ -1,5 +1,5 @@"))
        assertTrue(diff.contains("@@ -15,6 +15,6 @@"))
    }

    @Test
    fun `nearby changes share one hunk`() {
        val before = (1..10).joinToString("\n") { "l$it" } + "\n"
        val diff = unifiedDiff("f", before, before, listOf(LineRange(2, 3, 2, 3), LineRange(6, 7, 6, 7)))
        assertEquals(1, diff.lines().count { it.startsWith("@@") })
    }

    @Test
    fun `added file diffs against dev null`() {
        val diff = unifiedDiff("new.kt", null, "a\nb\n", null)
        assertEquals("--- /dev/null\n+++ b/new.kt\n@@ -0,0 +1,2 @@\n+a\n+b\n", diff)
    }

    @Test
    fun `deleted file diffs to dev null`() {
        val diff = unifiedDiff("old.kt", "a\n", null, null)
        assertEquals("--- a/old.kt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n", diff)
    }

    @Test
    fun `ranges past the end are clamped instead of throwing`() {
        val diff = unifiedDiff("f", "a\n", "a\nb\n", listOf(LineRange(1, 2, 1, 3)))
        assertTrue(diff.contains("+b"))
    }

    @Test
    fun `git diff file count and labels`() {
        val diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\ndiff --git a/y b/y\n"
        assertEquals(2, countGitDiffFiles(diff))
        assertEquals("Working tree diff (1 file)", diffLabel(1))
        assertEquals("Working tree diff (2 files)", diffLabel(2))
    }

    @Test
    fun `problems are formatted one per line with 1-based line numbers`() {
        assertEquals("ERROR line 3: Unresolved reference: foo", formatProblem("Error", 2, "Unresolved\n reference: foo"))
        assertEquals("No problems in A.kt", diagnosticsLabel(0, "A.kt"))
        assertEquals("1 problem in A.kt", diagnosticsLabel(1, "A.kt"))
    }

    @Test
    fun `language ids map to extensions`() {
        assertEquals("py", extensionForLanguageId("python"))
        assertEquals("tsx", extensionForLanguageId("typescriptreact"))
        assertEquals("kt", extensionForLanguageId("Kotlin"))
        assertEquals("rs", extensionForLanguageId("rs"))
        assertEquals("txt", extensionForLanguageId(null))
        assertEquals("txt", extensionForLanguageId("some weird language"))
    }

    @Test
    fun `host advertises exactly the IDE context kinds`() {
        // No "terminal": there is no public, stable terminal-selection API in 242+.
        assertEquals(listOf("file", "selection", "diff", "diagnostics", "gitlog"), JETBRAINS_CONTEXT_KINDS)
    }
}
