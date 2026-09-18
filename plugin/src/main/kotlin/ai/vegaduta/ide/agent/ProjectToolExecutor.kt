// The IntelliJ implementation of the shared coding toolset: the half that is
// allowed to touch the user's machine. Ported from
// clients/vscode/src/agent/workspaceTools.ts - the code differs because the
// platform does, the three invariants do not:
//
//  1. NOTHING escapes the project root. Every path the model supplies is
//     resolved, normalised and re-checked against the root before any I/O, and
//     re-checked again through the VFS so a symlink cannot walk out. A model
//     that asks for "../../.ssh/id_rsa" gets an error string, not a file.
//  2. NOTHING mutating happens without the user's say-so. Edits and commands go
//     through an approval gate the user controls; "allow for this run" is a
//     per-run decision that dies with the run, never a stored setting.
//  3. NOTHING throws. A tool failure is content the model reads and corrects.
//     An exception here would end a run that was one retry from succeeding.
//
// PLATFORM RULES THIS FILE HAS TO RESPECT, on top of the three above:
//  - Mutations run inside a WriteCommandAction, on the EDT. That is what puts
//    the agent's edits in the IDE's undo stack: a user who dislikes what it did
//    presses Ctrl-Z, not "restore from git".
//  - VFS refreshes must NOT happen under a read lock, so files are located
//    first and their contents read inside a ReadAction afterwards.
//  - Everything public here is called from a background thread (the loop is
//    blocking), and hops to the EDT itself where the platform demands it.

package ai.vegaduta.ide.agent

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessAdapter
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.impl.LoadTextUtil
import com.intellij.openapi.fileTypes.FileTypeRegistry
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.encoding.EncodingProjectManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.nio.charset.Charset
import java.nio.file.FileSystems
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.nio.file.PathMatcher
import java.nio.file.Paths
import java.util.concurrent.atomic.AtomicBoolean

/** Read cap per file. Big enough for real source files, small enough that one
 * minified bundle cannot evict the whole conversation from an 8k-context model. */
private const val MAX_READ_CHARS = 60_000
private const val MAX_SEARCH_FILES = 400
private const val MAX_SEARCH_MATCHES = 80
private const val MAX_SEARCH_LINE_CHARS = 200

/** Files this big are bundles, fixtures or minified output. Searching them
 * costs more than the match is ever worth. */
private const val MAX_SEARCHABLE_BYTES = 512_000L

private const val MAX_COMMAND_OUTPUT_CHARS = 20_000
private const val COMMAND_TIMEOUT_MS = 120_000L

/** How often a running command is checked against the caller's cancel flag. */
private const val COMMAND_POLL_MS = 200

/** Grace period for a killed process to actually die before we report. */
private const val COMMAND_KILL_GRACE_MS = 2_000

private val NOISE_DIRECTORIES = setOf(".git", "node_modules")

// ---------------------------------------------------------------------------
// The denylist
// ---------------------------------------------------------------------------

internal data class RefusedCommand(val pattern: Regex, val why: String)

/**
 * Commands that are never worth the risk of a model getting creative, and that
 * no legitimate coding task needs. This is a blunt backstop UNDER the approval
 * prompt, not a substitute for it - the user still approves everything else.
 * Deliberately short: a long denylist reads as a security boundary, and a
 * string denylist is not one.
 */
internal val REFUSED_COMMAND_PATTERNS: List<RefusedCommand> = listOf(
    RefusedCommand(
        Regex("""\brm\s+(-[a-z]*[rf][a-z]*\s+)+/(\s|$)""", RegexOption.IGNORE_CASE),
        "recursive delete of the filesystem root",
    ),
    // The Windows shape of the same mistake; this plugin runs on Windows as
    // often as anywhere else, and `rd /s /q C:\` is not a typo you recover from.
    RefusedCommand(
        Regex("""\b(rd|rmdir|del)\s+(/[a-z]\s+)*[a-z]:\\?(\s|$)""", RegexOption.IGNORE_CASE),
        "recursive delete of a drive root",
    ),
    RefusedCommand(
        Regex("""\b(mkfs\S*|fdisk|diskpart)\b|\bformat\s+[a-z]:""", RegexOption.IGNORE_CASE),
        "disk formatting",
    ),
    RefusedCommand(Regex("""\bdd\s+[^|]*of=/dev/""", RegexOption.IGNORE_CASE), "raw write to a block device"),
    RefusedCommand(Regex(""":\(\)\s*\{\s*:\|:&\s*\}\s*;:"""), "fork bomb"),
    RefusedCommand(
        Regex("""\bgit\s+push\b[^\n]*--force""", RegexOption.IGNORE_CASE),
        "force push - run this yourself if you mean it",
    ),
    RefusedCommand(Regex("""\bshutdown\b|\breboot\b|\bhalt\b""", RegexOption.IGNORE_CASE), "power state change"),
)

/** Why this command is refused outright, or null when it may be offered to the
 * user for approval. */
internal fun commandRefusalReason(command: String): String? =
    REFUSED_COMMAND_PATTERNS.firstOrNull { it.pattern.containsMatchIn(command) }?.why

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Resolve a model-supplied, project-relative path and prove it stays inside the
 * root. Returns null for anything that escapes.
 *
 * Path.normalize() collapses ".." textually and Path.startsWith() compares
 * whole name elements, so "../secrets" leaves the root and a sibling directory
 * called "project-secrets" is not mistaken for a child of "project". Doing this
 * with string prefixes is exactly how that second bug ships.
 *
 * A leading separator is tolerated and re-anchored at the root rather than
 * treated as an absolute path: models emit "/src/main.kt" constantly, and
 * re-anchoring keeps them inside. A genuinely absolute path (a Windows drive
 * letter, a UNC share) survives resolve() as absolute and is then rejected by
 * the containment check.
 */
internal fun resolveWithinRoot(root: Path, relative: String): Path? {
    val base = root.toAbsolutePath().normalize()
    val cleaned = relative.trim().replace('\\', '/').trimStart('/')
    if (cleaned.isEmpty() || cleaned == ".") return base
    val resolved = try {
        base.resolve(cleaned).normalize()
    } catch (_: InvalidPathException) {
        return null
    }
    return if (resolved == base || resolved.startsWith(base)) resolved else null
}

/** Project-relative, POSIX-separated rendering of a contained path - what the
 * model sees in every result, so it can hand the same string straight back. */
internal fun describeWithinRoot(root: Path, path: Path): String {
    val base = root.toAbsolutePath().normalize()
    val relative = try {
        base.relativize(path.toAbsolutePath().normalize()).toString()
    } catch (_: IllegalArgumentException) {
        return path.toString().replace('\\', '/')
    }
    return if (relative.isEmpty()) "." else relative.replace('\\', '/')
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

enum class ApprovalKind { EDIT, COMMAND }

/**
 * Per-run approval. "Allow for the rest of this run" is intentionally held in
 * memory on this object: it expires when the run does, and cannot be
 * accidentally persisted into settings where the user would forget it is on.
 *
 * Thread contract: request() is called from the agent's background thread and
 * hops to the EDT itself, because IntelliJ throws if a dialog is shown from
 * anywhere else.
 */
class ApprovalGate(
    private val project: Project?,
    private val autoApprove: Map<ApprovalKind, Boolean> = emptyMap(),
) {
    @Volatile
    private var allowAllEdits = false

    @Volatile
    private var allowAllCommands = false

    @Volatile
    private var cancelled = false

    val wasCancelled: Boolean get() = cancelled

    fun request(kind: ApprovalKind, summary: String, detail: String? = null): Boolean {
        if (cancelled) return false
        if (autoApprove[kind] == true) return true
        if (if (kind == ApprovalKind.EDIT) allowAllEdits else allowAllCommands) return true

        val allowAllLabel = if (kind == ApprovalKind.EDIT) "Allow all edits this run" else "Allow all commands this run"
        val options = arrayOf("Allow", allowAllLabel, "Stop the agent")
        val message = if (detail.isNullOrBlank()) summary else "$summary\n\n$detail"

        var choice = -1
        ApplicationManager.getApplication().invokeAndWait({
            choice = Messages.showDialog(
                project,
                message,
                "VegaDuta Agent",
                options,
                0,
                Messages.getWarningIcon(),
            )
        }, ModalityState.defaultModalityState())

        when (choice) {
            0 -> return true
            1 -> {
                if (kind == ApprovalKind.EDIT) allowAllEdits = true else allowAllCommands = true
                return true
            }
            2 -> cancelled = true
        }
        // Closing the dialog is a refusal of this step, not of the run. Only the
        // explicit stop ends things - otherwise an accidental Escape kills the work.
        return false
    }
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.nonEmptyText(key: String): String? = text(key)?.takeIf { it.isNotEmpty() }

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.content?.trim()?.toIntOrNull()

private fun JsonObject.flag(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true

private fun ok(content: String) = ToolOutcome(content)

private fun fail(content: String) = ToolOutcome("Error: $content", failed = true)

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * @param rootPath the directory the agent is confined to - normally the project
 *   base directory. Must be a real local directory: these tools spawn processes
 *   in it and hand its paths to a shell.
 */
class ProjectToolExecutor(
    private val project: Project,
    rootPath: Path,
    private val approvals: ApprovalGate,
    private val log: (String) -> Unit = {},
) : ToolExecutor {

    private val root: Path = rootPath.toAbsolutePath().normalize()

    override fun specs(): List<ToolSpec> = CODING_TOOL_SPECS

    override fun execute(call: ToolCall, cancelled: AtomicBoolean): ToolOutcome =
        try {
            when (call.name) {
                LIST_DIR -> listDir(call.args)
                READ_FILE -> readFile(call.args)
                SEARCH_TEXT -> searchText(call.args, cancelled)
                WRITE_FILE -> writeFile(call.args)
                EDIT_FILE -> editFile(call.args)
                RUN_COMMAND -> runCommand(call.args, cancelled)
                else -> fail("unknown tool \"${call.name}\"")
            }
        } catch (cancel: ProcessCanceledException) {
            // The platform's cancellation signal, not a tool failure. Swallowing
            // it strands a cancelled progress indicator, so it goes back up.
            throw cancel
        } catch (error: Exception) {
            // Invariant 3: a thrown tool is a message, never a dead run.
            fail(error.message ?: error.toString())
        }

    // -------------------------------------------------------------------------
    // Containment
    // -------------------------------------------------------------------------

    /** Invariant 1, first half: the textual check, before any I/O happens. */
    private fun locate(relative: String): Path? = resolveWithinRoot(root, relative)

    private fun outside(path: String) = fail("path \"$path\" is outside the project")

    /**
     * Invariant 1, second half. resolveWithinRoot() cannot see a symlink, so the
     * located file is re-checked through the VFS against the canonical root -
     * a "docs" symlink pointing at /etc is a contained path and an escaped file.
     *
     * Not called under a read lock: refreshAndFindFileByNioFile performs a VFS
     * refresh, which the platform forbids there.
     */
    private fun findContained(path: Path): VirtualFile? {
        val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path) ?: return null
        val rootFile = rootFile() ?: return null
        return if (contains(rootFile, file)) file else null
    }

    /** Refreshes the VFS, so never called under a read lock or inside a write
     * action - the platform forbids a synchronous refresh in both. */
    private fun rootFile(): VirtualFile? = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root)

    /** Canonical, so a symlink is judged by where it points, not by its name. */
    private fun contains(rootFile: VirtualFile, file: VirtualFile): Boolean =
        VfsUtilCore.isAncestor(rootFile.canonicalFile ?: rootFile, file.canonicalFile ?: file, false)

    // -------------------------------------------------------------------------
    // Read-only tools
    // -------------------------------------------------------------------------

    private fun listDir(args: JsonObject): ToolOutcome {
        val path = args.nonEmptyText("path") ?: "."
        val target = locate(path) ?: return outside(path)
        val dir = findContained(target) ?: return fail("no such directory: $path")
        if (!dir.isDirectory) return fail("$path is a file, not a directory - use read_file")

        val names = ReadAction.compute<List<String>, RuntimeException> {
            dir.children
                .filter { it.name !in NOISE_DIRECTORIES }
                .sortedWith(compareBy({ !it.isDirectory }, { it.name }))
                .map { if (it.isDirectory) "${it.name}/" else it.name }
        }
        if (names.isEmpty()) return ok("(empty directory: $path)")
        return ok("$path:\n${names.joinToString("\n")}")
    }

    private fun readFile(args: JsonObject): ToolOutcome {
        val path = args.nonEmptyText("path") ?: return fail("read_file needs a \"path\" argument")
        val target = locate(path) ?: return outside(path)
        val file = findContained(target) ?: return fail("no such file: $path")
        if (file.isDirectory) return fail("$path is a directory - use list_dir")
        if (FileTypeRegistry.getInstance().getFileTypeByFile(file).isBinary) {
            return fail("$path is a binary file")
        }

        val text = ReadAction.compute<String, RuntimeException> { LoadTextUtil.loadText(file).toString() }
        val allLines = text.lines()
        val start = maxOf(1, args.int("start_line") ?: 1)
        val end = minOf(allLines.size, args.int("end_line") ?: allLines.size)
        if (start > allLines.size) {
            return fail("start_line $start is past the end of $path (${allLines.size} lines)")
        }

        val selected = if (start > end) emptyList() else allLines.subList(start - 1, end)
        var body = selected.mapIndexed { index, line -> "${start + index}\t$line" }.joinToString("\n")
        var note = ""
        if (body.length > MAX_READ_CHARS) {
            body = body.substring(0, MAX_READ_CHARS)
            note = "\n... truncated at $MAX_READ_CHARS characters - re-read with start_line/end_line for the rest."
        }
        return ok("$path (lines $start-$end of ${allLines.size}):\n$body$note")
    }

    /**
     * Search. Enumeration goes through ProjectFileIndex rather than a directory
     * walk: it already knows what is content and what is build output, excluded
     * or ignored, so the search inherits the user's own project model instead of
     * a hard-coded skip list that drifts from it.
     *
     * The line matching itself is a plain scan - the platform's word index
     * answers "which files contain this identifier", not "which line and what
     * does it say", which is what the model needs back.
     */
    private fun searchText(args: JsonObject, cancelled: AtomicBoolean): ToolOutcome {
        val query = args.nonEmptyText("query") ?: return fail("search_text needs a \"query\" argument")
        val include = args.nonEmptyText("include")

        val matcher = try {
            Regex(if (args.flag("is_regex")) query else Regex.escape(query), RegexOption.IGNORE_CASE)
        } catch (error: Exception) {
            return fail("invalid regular expression: ${error.message ?: query}")
        }
        val globMatcher: PathMatcher? = if (include == null || include == "**/*") {
            null
        } else {
            try {
                FileSystems.getDefault().getPathMatcher("glob:$include")
            } catch (error: Exception) {
                return fail("invalid include glob \"$include\": ${error.message ?: "not a glob"}")
            }
        }

        val hits = mutableListOf<String>()
        var scanned = 0
        val charset = EncodingProjectManager.getInstance(project).defaultCharset

        ReadAction.run<RuntimeException> {
            ProjectFileIndex.getInstance(project).iterateContent { file ->
                if (cancelled.get() || hits.size >= MAX_SEARCH_MATCHES || scanned >= MAX_SEARCH_FILES) {
                    return@iterateContent false
                }
                if (file.isDirectory || file.length > MAX_SEARCHABLE_BYTES) return@iterateContent true
                if (FileTypeRegistry.getInstance().getFileTypeByFile(file).isBinary) return@iterateContent true

                val nio = try {
                    file.toNioPath()
                } catch (_: UnsupportedOperationException) {
                    return@iterateContent true
                }
                // A multi-root project's index reaches content outside this root.
                if (!nio.toAbsolutePath().normalize().startsWith(root)) return@iterateContent true

                val relative = describeWithinRoot(root, nio)
                if (globMatcher != null && !globMatcher.matches(Paths.get(relative))) {
                    return@iterateContent true
                }

                scanned += 1
                val text = try {
                    String(file.contentsToByteArray(), charset)
                } catch (_: Exception) {
                    return@iterateContent true // unreadable is not an error worth reporting
                }
                text.lineSequence().forEachIndexed { index, line ->
                    if (hits.size < MAX_SEARCH_MATCHES && matcher.containsMatchIn(line)) {
                        hits += "$relative:${index + 1}: ${line.trim().take(MAX_SEARCH_LINE_CHARS)}"
                    }
                }
                true
            }
        }

        if (hits.isEmpty()) return ok("No matches for \"$query\" in ${include ?: "the project"}.")
        val capped = if (hits.size >= MAX_SEARCH_MATCHES) "\n(stopped at $MAX_SEARCH_MATCHES matches)" else ""
        return ok("${hits.size} match(es):\n${hits.joinToString("\n")}$capped")
    }

    // -------------------------------------------------------------------------
    // Mutating tools
    // -------------------------------------------------------------------------

    private fun writeFile(args: JsonObject): ToolOutcome {
        val path = args.nonEmptyText("path") ?: return fail("write_file needs a \"path\" argument")
        val content = args.text("content") ?: return fail("write_file needs a \"content\" argument")
        val target = locate(path) ?: return outside(path)

        val existing = findContained(target)
        if (existing != null && existing.isDirectory) return fail("$path is a directory")
        val rootFile = rootFile() ?: return fail("the project root $root is no longer readable")
        val previousLines = existing?.let {
            ReadAction.compute<Int, RuntimeException> { LoadTextUtil.loadText(it).lines().size }
        }
        val newLines = content.lines().size

        val approved = approvals.request(
            ApprovalKind.EDIT,
            if (existing != null) "VegaDuta wants to REPLACE all of $path" else "VegaDuta wants to CREATE $path",
            if (existing != null) "$previousLines existing lines will be replaced by $newLines lines." else "$newLines lines.",
        )
        if (!approved) return fail("the user declined the write to $path")

        val outcome = inWriteCommand(if (existing != null) "VegaDuta: rewrite $path" else "VegaDuta: create $path") {
            val file = existing
                ?: createFile(rootFile, target)
                ?: return@inWriteCommand fail("could not create $path - its parent is missing or leaves the project")
            setText(file, content)
            ok("${if (existing != null) "Replaced" else "Created"} $path ($newLines lines).")
        }
        if (!outcome.failed) log("${if (existing != null) "rewrote" else "created"} $path")
        return outcome
    }

    private fun editFile(args: JsonObject): ToolOutcome {
        val path = args.nonEmptyText("path") ?: return fail("edit_file needs a \"path\" argument")
        val oldText = args.text("old_text") ?: return fail("edit_file needs an \"old_text\" argument")
        val newText = args.text("new_text") ?: return fail("edit_file needs a \"new_text\" argument")
        if (oldText.isEmpty()) return fail("old_text must not be empty - use write_file to create a file")

        val target = locate(path) ?: return outside(path)
        val file = findContained(target) ?: return fail("no such file: $path")
        if (file.isDirectory) return fail("$path is a directory")

        val text = ReadAction.compute<String, RuntimeException> { LoadTextUtil.loadText(file).toString() }
        val first = text.indexOf(oldText)
        if (first < 0) {
            return fail(
                "old_text was not found in $path. It must match the file exactly, including " +
                    "indentation and line endings. Re-read the file and copy the snippet verbatim."
            )
        }
        if (text.indexOf(oldText, first + oldText.length) >= 0) {
            return fail(
                "old_text occurs more than once in $path. Include more surrounding context so it " +
                    "identifies exactly one location."
            )
        }

        val lineNumber = text.substring(0, first).count { it == '\n' } + 1
        val approved = approvals.request(
            ApprovalKind.EDIT,
            "VegaDuta wants to edit $path (line $lineNumber)",
            "- ${oldText.lines().size} line(s) removed\n+ ${newText.lines().size} line(s) added",
        )
        if (!approved) return fail("the user declined the edit to $path")

        val outcome = inWriteCommand("VegaDuta: edit $path") {
            // Re-read inside the write action: the user may have typed in this
            // file while the approval dialog was up, and splicing at an offset
            // measured before that would land in the middle of their edit.
            val current = documentTextOf(file)
            val at = current.indexOf(oldText)
            if (at < 0) {
                fail("$path changed while waiting for approval and old_text no longer matches - re-read it")
            } else if (current.indexOf(oldText, at + oldText.length) >= 0) {
                fail("$path changed while waiting for approval and old_text now occurs more than once - re-read it")
            } else {
                setText(file, current.substring(0, at) + newText + current.substring(at + oldText.length))
                ok("Edited $path at line $lineNumber.")
            }
        }
        if (!outcome.failed) log("edited $path:$lineNumber")
        return outcome
    }

    private fun runCommand(args: JsonObject, cancelled: AtomicBoolean): ToolOutcome {
        val command = args.nonEmptyText("command") ?: return fail("run_command needs a \"command\" argument")

        commandRefusalReason(command)?.let { return fail("refusing to run this command ($it)") }

        val cwdRelative = args.nonEmptyText("cwd") ?: "."
        val cwd = locate(cwdRelative) ?: return fail("cwd \"$cwdRelative\" is outside the project")
        val cwdFile = findContained(cwd) ?: return fail("no such directory: $cwdRelative")
        if (!cwdFile.isDirectory) return fail("cwd \"$cwdRelative\" is not a directory")

        if (!approvals.request(ApprovalKind.COMMAND, "VegaDuta wants to run a command", "$command\n\nin $cwdRelative")) {
            return fail("the user declined to run that command")
        }

        val windows = System.getProperty("os.name").orEmpty().startsWith("Windows", ignoreCase = true)
        val commandLine = if (windows) {
            GeneralCommandLine(System.getenv("ComSpec") ?: "cmd.exe", "/c", command)
        } else {
            GeneralCommandLine("/bin/sh", "-c", command)
        }
            .withWorkDirectory(cwd.toFile())
            // The shell writes in the OS default encoding; the project's own
            // encoding is about source files and would mangle console output.
            .withCharset(Charset.defaultCharset())
            .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)

        log("$ $command")
        val handler = try {
            CapturingProcessHandler(commandLine)
        } catch (error: Exception) {
            return fail("could not start the command: ${error.message ?: error.toString()}")
        }
        val captured = CapturingProcessAdapter()
        handler.addProcessListener(captured)
        handler.startNotify()

        var waited = 0L
        while (!handler.waitFor(COMMAND_POLL_MS.toLong())) {
            waited += COMMAND_POLL_MS
            if (cancelled.get()) {
                handler.destroyProcess()
                handler.waitFor(COMMAND_KILL_GRACE_MS.toLong())
                return fail("the run was cancelled while this command was executing")
            }
            if (waited >= COMMAND_TIMEOUT_MS) {
                handler.destroyProcess()
                handler.waitFor(COMMAND_KILL_GRACE_MS.toLong())
                return fail("command timed out after ${COMMAND_TIMEOUT_MS / 1000}s: $command")
            }
        }

        val output = captured.output
        val parts = mutableListOf("exit code: ${handler.exitCode ?: "unknown"}")
        if (output.stdout.isNotBlank()) parts += "stdout:\n${tail(output.stdout)}"
        if (output.stderr.isNotBlank()) parts += "stderr:\n${tail(output.stderr)}"
        if (output.stdout.isBlank() && output.stderr.isBlank()) parts += "(no output)"
        // A non-zero exit is a normal, expected result the model must read and
        // act on - not a tool failure.
        return ok(parts.joinToString("\n\n"))
    }

    /** Tails, not heads: compilers and test runners put the part you need at the
     * end, and a head-truncated failure is useless to the model. */
    private fun tail(text: String): String =
        if (text.length > MAX_COMMAND_OUTPUT_CHARS) {
            "... (truncated)\n${text.substring(text.length - MAX_COMMAND_OUTPUT_CHARS)}"
        } else {
            text
        }

    // -------------------------------------------------------------------------
    // Writing
    // -------------------------------------------------------------------------

    /**
     * Runs the body on the EDT inside a write command, which is what puts the
     * change in the IDE's undo stack - the user's real escape hatch from an
     * agent that did the wrong thing. Content changes go through the file's
     * Document, so Ctrl-Z restores the previous text; note that undoing a
     * newly CREATED file empties it rather than removing it.
     */
    private fun inWriteCommand(name: String, body: () -> ToolOutcome): ToolOutcome {
        var outcome: ToolOutcome = fail("the write action did not run")
        ApplicationManager.getApplication().invokeAndWait({
            outcome = try {
                WriteCommandAction.writeCommandAction(project)
                    .withName(name)
                    .compute<ToolOutcome, Exception> { body() }
            } catch (error: Exception) {
                fail(error.message ?: error.toString())
            }
        }, ModalityState.defaultModalityState())
        return outcome
    }

    /**
     * Write-action only.
     *
     * Invariant 1 one last time: before creating anything, the deepest directory
     * that ALREADY exists on the way to the target is proved to be inside the
     * canonical root. Creating first and checking after would have followed a
     * symlinked parent out of the project and left directories there.
     */
    private fun createFile(rootFile: VirtualFile, target: Path): VirtualFile? {
        var probe: Path? = target.parent
        var nearest: VirtualFile? = null
        while (probe != null && nearest == null) {
            nearest = LocalFileSystem.getInstance().findFileByNioFile(probe)
            probe = probe.parent
        }
        if (nearest == null || !contains(rootFile, nearest)) return null

        val relative = describeWithinRoot(root, target)
        val parentRelative = relative.substringBeforeLast('/', "")
        val parent = if (parentRelative.isEmpty()) {
            rootFile
        } else {
            VfsUtil.createDirectoryIfMissing(rootFile, parentRelative)
        } ?: return null
        val name = relative.substringAfterLast('/')
        return parent.findChild(name) ?: parent.createChildData(this, name)
    }

    /** Write-action only. */
    private fun documentTextOf(file: VirtualFile): String =
        FileDocumentManager.getInstance().getDocument(file)?.text ?: LoadTextUtil.loadText(file).toString()

    /**
     * Write-action only. Through the Document where there is one, so the change
     * is undoable and any editor showing the file updates; saved immediately
     * because run_command reads the file from disk moments later.
     *
     * Documents hold '\n' only - the platform re-applies the file's own
     * separators on save - so a model that sent CRLF is normalised here rather
     * than tripping the platform's assertion.
     */
    private fun setText(file: VirtualFile, content: String) {
        val manager = FileDocumentManager.getInstance()
        val document = manager.getDocument(file)
        if (document == null) {
            VfsUtil.saveText(file, content)
            return
        }
        document.setText(content.replace("\r\n", "\n").replace('\r', '\n'))
        manager.saveDocument(document)
    }
}
