package ai.vegaduta.ide.context

import org.junit.jupiter.api.Assumptions.assumeTrue
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RevealTargetTest {
    private lateinit var tmp: Path
    private lateinit var project: Path
    private lateinit var outside: Path

    @BeforeTest
    fun setUp() {
        tmp = Files.createTempDirectory("vegaduta-reveal")
        project = tmp.resolve("project").createDirectories()
        outside = tmp.resolve("outside").createDirectories()
        project.resolve("src").createDirectories()
        project.resolve("src/App.kt").writeText("fun main() {}\n")
        outside.resolve("secret.txt").writeText("no")
    }

    @AfterTest
    fun tearDown() {
        tmp.toFile().deleteRecursively()
    }

    private fun inside(requested: String): Path =
        assertIs<RevealPath.Inside>(resolveRevealPath(project, requested), requested).path

    private fun refused(requested: String): String =
        assertIs<RevealPath.Refused>(resolveRevealPath(project, requested), requested).reason

    @Test
    fun `project-relative paths resolve inside the project`() {
        assertEquals(project.resolve("src/App.kt").normalize(), inside("src/App.kt"))
        assertEquals(project.resolve("src/App.kt").normalize(), inside("./src/../src/App.kt"))
        // Windows separators, as a model might write them.
        assertEquals(project.resolve("src/App.kt").normalize(), inside("src\\App.kt"))
        // Not existing yet is fine here - the VFS lookup reports "not found".
        assertEquals(project.resolve("src/New.kt").normalize(), inside("src/New.kt"))
    }

    @Test
    fun `an absolute path inside the project is accepted`() {
        val abs = project.resolve("src/App.kt").toAbsolutePath().toString()
        assertEquals(project.resolve("src/App.kt").normalize(), inside(abs))
    }

    @Test
    fun `climbing out with dot-dot is refused`() {
        assertTrue(refused("../outside/secret.txt").contains("outside this project"))
        refused("src/../../outside/secret.txt")
        refused("..")
    }

    @Test
    fun `absolute paths elsewhere are refused`() {
        refused(outside.resolve("secret.txt").toAbsolutePath().toString())
        refused("/etc/passwd")
        refused("\\\\server\\share\\file.txt")
    }

    @Test
    fun `the project root itself, blank and NUL paths are refused`() {
        refused(".")
        refused("")
        refused("   ")
        refused("src/App.kt\u0000.png")
    }

    @Test
    fun `a symlink inside the project that points outside is refused`() {
        val link = project.resolve("docs")
        val made = runCatching { Files.createSymbolicLink(link, outside) }.isSuccess
        // Creating symlinks needs Developer Mode or admin on Windows.
        assumeTrue(made, "symlinks not creatable on this machine")
        assertTrue(refused("docs/secret.txt").contains("points outside"))
    }

    @Test
    fun `line range is converted from 1-based inclusive to 0-based and clamped`() {
        assertEquals(Pair(0, 0), revealLineRange(1, 1, 10))
        assertEquals(Pair(4, 9), revealLineRange(5, 10, 10))
        assertEquals(Pair(4, 9), revealLineRange(5, 400, 10), "end past the file lands on the last line")
        assertEquals(Pair(9, 9), revealLineRange(50, 60, 10), "start past the file lands on the last line")
        assertEquals(Pair(2, 6), revealLineRange(7, 3, 10), "reversed range is swapped")
    }

    @Test
    fun `invalid line numbers or an empty document give no range`() {
        assertNull(revealLineRange(0, 3, 10))
        assertNull(revealLineRange(3, -1, 10))
        assertNull(revealLineRange(1, 1, 0))
    }
}
