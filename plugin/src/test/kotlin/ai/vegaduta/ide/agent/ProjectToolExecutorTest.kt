// The two things in ProjectToolExecutor that must never silently regress:
// path containment (invariant 1) and the command denylist. Both are pure
// functions precisely so they can be tested without an IDE fixture - the rest
// of the executor is VFS, write actions and process handling, which needs a
// running platform and is NOT covered here.
//
// Same style as AgentTest: plain kotlin.test, no platform classes touched.

package ai.vegaduta.ide.agent

import java.nio.file.Path
import java.nio.file.Paths
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val ROOT: Path = Paths.get("project").toAbsolutePath().normalize()

class PathContainmentTest {

    @Test
    fun `resolves an ordinary relative path under the root`() {
        val resolved = assertNotNull(resolveWithinRoot(ROOT, "src/main/Main.kt"))
        assertTrue(resolved.startsWith(ROOT))
        assertEquals("src/main/Main.kt", describeWithinRoot(ROOT, resolved))
    }

    @Test
    fun `treats an empty path and a dot as the root itself`() {
        assertEquals(ROOT, resolveWithinRoot(ROOT, ""))
        assertEquals(ROOT, resolveWithinRoot(ROOT, "."))
        assertEquals(ROOT, resolveWithinRoot(ROOT, "   "))
        assertEquals(".", describeWithinRoot(ROOT, ROOT))
    }

    @Test
    fun `refuses the classic traversal out of the project`() {
        assertNull(resolveWithinRoot(ROOT, "../../.ssh/id_rsa"))
        assertNull(resolveWithinRoot(ROOT, ".."))
        assertNull(resolveWithinRoot(ROOT, "src/../../etc/passwd"))
        assertNull(resolveWithinRoot(ROOT, "src/main/../../../elsewhere"))
    }

    @Test
    fun `refuses a sibling directory that merely shares the root's name prefix`() {
        // The bug a string-prefix containment check ships with: "project-secrets"
        // starts with "project" as text and is not inside it as a path.
        assertNull(resolveWithinRoot(ROOT, "../${ROOT.fileName}-secrets/key.pem"))
    }

    @Test
    fun `re-anchors a leading separator instead of following it off the root`() {
        // Models emit "/src/a.kt" constantly. It must mean the project's src,
        // never the filesystem's.
        val resolved = assertNotNull(resolveWithinRoot(ROOT, "/src/a.kt"))
        assertEquals(ROOT.resolve("src").resolve("a.kt"), resolved)
    }

    @Test
    fun `normalises backslash separators the same way`() {
        assertEquals(ROOT.resolve("src").resolve("a.kt"), resolveWithinRoot(ROOT, "src\\a.kt"))
        assertNull(resolveWithinRoot(ROOT, "..\\..\\.ssh\\id_rsa"))
    }

    @Test
    fun `no hostile path escapes, whatever shape it arrives in`() {
        val hostile = listOf(
            "../../.ssh/id_rsa",
            "../../../../../../etc/shadow",
            "C:/Windows/System32/drivers/etc/hosts",
            "C:\\Windows\\System32",
            "\\\\server\\share\\secret.txt",
            "//server/share/secret.txt",
            "src/./../../out",
            "\u0000/etc/passwd",
            "....//....//etc/passwd",
        )
        for (path in hostile) {
            val resolved = resolveWithinRoot(ROOT, path)
            // Either refused outright, or re-anchored - never a path outside the root.
            if (resolved != null) {
                assertTrue(resolved.startsWith(ROOT), "escaped the root: $path -> $resolved")
            }
        }
    }

    @Test
    fun `rejects a path the filesystem cannot even represent`() {
        assertNull(resolveWithinRoot(ROOT, "src/\u0000/a.kt"))
    }

    @Test
    fun `describes contained paths POSIX-style regardless of platform`() {
        val nested = assertNotNull(resolveWithinRoot(ROOT, "a/b/c.txt"))
        assertEquals("a/b/c.txt", describeWithinRoot(ROOT, nested))
    }
}

class CommandDenylistTest {

    @Test
    fun `refuses a recursive delete of the filesystem root`() {
        assertEquals("recursive delete of the filesystem root", commandRefusalReason("rm -rf /"))
        assertEquals("recursive delete of the filesystem root", commandRefusalReason("sudo rm -fr / "))
        // Case is not a way around it.
        assertNotNull(commandRefusalReason("RM -RF /"))
    }

    @Test
    fun `refuses a recursive delete of a Windows drive root`() {
        assertEquals("recursive delete of a drive root", commandRefusalReason("rd /s /q C:\\"))
        assertEquals("recursive delete of a drive root", commandRefusalReason("del /f /s /q C:"))
    }

    @Test
    fun `refuses disk formatting, raw device writes and fork bombs`() {
        assertEquals("disk formatting", commandRefusalReason("mkfs.ext4 /dev/sda1"))
        assertEquals("disk formatting", commandRefusalReason("diskpart"))
        assertEquals("disk formatting", commandRefusalReason("format C: /q"))
        assertEquals("raw write to a block device", commandRefusalReason("dd if=/dev/zero of=/dev/sda bs=1M"))
        assertNotNull(commandRefusalReason(":(){ :|:& };:"))
    }

    @Test
    fun `refuses a force push and anything that power-cycles the machine`() {
        assertNotNull(commandRefusalReason("git push --force origin main"))
        assertNotNull(commandRefusalReason("git push origin main --force-with-lease"))
        assertEquals("power state change", commandRefusalReason("sudo shutdown -h now"))
        assertEquals("power state change", commandRefusalReason("reboot"))
    }

    @Test
    fun `lets the ordinary build, test and git commands through to the approval prompt`() {
        val allowed = listOf(
            "npm test",
            "./gradlew :clients:jetbrains:test",
            "mvn -q verify",
            "rm -rf build",
            "rm -rf node_modules/.cache",
            "rmdir build",
            "git push origin feature/agent",
            "git status",
            "dd if=input.bin of=output.bin",
            "pytest -k formatting",
            "cargo build --release",
        )
        for (command in allowed) {
            assertNull(commandRefusalReason(command), "wrongly refused: $command")
        }
    }

    @Test
    fun `every pattern carries a reason a human can read`() {
        for (entry in REFUSED_COMMAND_PATTERNS) {
            assertTrue(entry.why.isNotBlank())
        }
    }
}
