// Answers context.request (clients/shared/src/webview/protocol.ts) from the
// IDE's own state, using public IntelliJ Platform API only:
//  - file / selection: FileEditorManager's selected text editor, read on the
//    EDT (where FileEditorManager and the selection model must be read);
//  - diagnostics: DaemonCodeAnalyzerEx.processHighlights over that editor's
//    document - what the IDE last highlighted, WARNING and above;
//  - diff: ChangeListManager's uncommitted changes rendered with
//    ComparisonManager as a unified diff (any VCS the IDE has configured),
//    falling back to `git diff HEAD` in the project root when no VCS is
//    configured in the IDE. Revision contents are read on the calling
//    (pooled) thread, never on the EDT.
//  - gitlog: `git log -n 30` in the project's git root (the IDE's Git VCS
//    root when it has one, else the nearest folder above the project holding
//    .git), with a 15-second timeout. Needs git on PATH.
// Every requested kind comes back either as an item or in `missing` with a
// reason - never as a silently empty item.

package ai.vegaduta.ide.context

import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.diff.comparison.ComparisonManager
import com.intellij.diff.comparison.ComparisonPolicy
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.EmptyProgressIndicator
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import com.intellij.openapi.vcs.changes.BinaryContentRevision
import com.intellij.openapi.vcs.changes.Change
import com.intellij.openapi.vcs.changes.ChangeListManager
import com.intellij.openapi.vcs.changes.ContentRevision
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import java.io.File
import java.nio.charset.StandardCharsets

data class ContextResult(val items: List<ContextItem>, val missing: List<MissingContext>)

class IdeContextCollector(private val project: Project) {
    private val log = logger<IdeContextCollector>()

    /** Must NOT be called on the EDT: it waits for the EDT and may read VCS content. */
    fun collect(kinds: List<String>): ContextResult {
        val items = mutableListOf<ContextItem>()
        val missing = mutableListOf<MissingContext>()
        val wanted = kinds.distinct()

        val editorKinds = wanted.filter { it == "file" || it == "selection" || it == "diagnostics" }
        if (editorKinds.isNotEmpty()) {
            val snapshot = editorSnapshot(editorKinds)
            items += snapshot.items
            missing += snapshot.missing
        }
        for (kind in wanted) {
            when (kind) {
                "file", "selection", "diagnostics" -> Unit // handled above
                "diff" -> try {
                    collectDiff()
                } catch (e: Exception) {
                    log.info("diff context failed", e)
                    Pair(null, "Could not read uncommitted changes: ${e.message ?: e.javaClass.simpleName}")
                }.let { (item, reason) ->
                    if (item != null) items += item else missing += MissingContext("diff", reason ?: "No diff available.")
                }
                "gitlog" -> try {
                    collectGitLog()
                } catch (e: Exception) {
                    log.info("gitlog context failed", e)
                    Pair(null, "Could not read recent commits: ${e.message ?: e.javaClass.simpleName}")
                }.let { (item, reason) ->
                    if (item != null) items += item else missing += MissingContext("gitlog", reason ?: "No commits available.")
                }
                "page" -> missing += MissingContext("page", "An IDE has no browser page to attach.")
                else -> missing += MissingContext(kind, "Unknown context kind \"$kind\".")
            }
        }
        return ContextResult(items, missing)
    }

    // --- editor-backed kinds ------------------------------------------------

    private fun editorSnapshot(kinds: List<String>): ContextResult {
        var result = ContextResult(emptyList(), kinds.map { MissingContext(it, "The IDE did not answer in time.") })
        ApplicationManager.getApplication().invokeAndWait({
            result = try {
                ReadAction.compute<ContextResult, RuntimeException> { readEditor(kinds) }
            } catch (e: Exception) {
                log.info("editor context failed", e)
                ContextResult(emptyList(), kinds.map { MissingContext(it, "Could not read the editor: ${e.message}") })
            }
        }, ModalityState.any())
        return result
    }

    private fun readEditor(kinds: List<String>): ContextResult {
        if (project.isDisposed) return ContextResult(emptyList(), kinds.map { MissingContext(it, "The project is closed.") })
        val editor = FileEditorManager.getInstance(project).selectedTextEditor
            ?: return ContextResult(emptyList(), kinds.map { MissingContext(it, "No file is open in the editor.") })
        val document = editor.document
        val file: VirtualFile? = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
        val label = file?.let { projectRelativePath(it) } ?: "Untitled"
        val fileName = file?.name ?: "the current file"
        val languageId = file?.fileType?.name?.lowercase()
        val items = mutableListOf<ContextItem>()
        val missing = mutableListOf<MissingContext>()
        for (kind in kinds) {
            when (kind) {
                "file" -> items += contextItem("file", label, document.text, languageId)
                "selection" -> {
                    val selected = editor.selectionModel.selectedText
                    if (selected.isNullOrEmpty()) {
                        missing += MissingContext("selection", "Nothing is selected in $fileName.")
                    } else {
                        items += contextItem("selection", selectionLabel(selected, file?.name), selected, languageId)
                    }
                }
                "diagnostics" -> {
                    val lines = mutableListOf<String>()
                    val ok = runCatching {
                        DaemonCodeAnalyzerEx.processHighlights(
                            document, project, HighlightSeverity.WARNING, 0, document.textLength
                        ) { info: HighlightInfo ->
                            val message = info.description
                            if (!message.isNullOrBlank()) {
                                val line = document.getLineNumber(info.startOffset.coerceIn(0, document.textLength))
                                lines += formatProblem(info.severity.name, line, message)
                            }
                            true
                        }
                    }
                    if (ok.isFailure) {
                        missing += MissingContext("diagnostics", "The IDE's problem list for $fileName could not be read.")
                    } else {
                        val distinct = lines.distinct()
                        val text = if (distinct.isEmpty()) {
                            "The IDE reports no errors or warnings in $label (as of its last analysis of the file)."
                        } else {
                            "Problems the IDE reports in $label:\n" + distinct.joinToString("\n")
                        }
                        items += contextItem("diagnostics", diagnosticsLabel(distinct.size, fileName), text)
                    }
                }
            }
        }
        return ContextResult(items, missing)
    }

    private fun projectRelativePath(file: VirtualFile): String {
        val base = project.basePath ?: return file.name
        val baseFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(base) ?: return file.name
        return VfsUtilCore.getRelativePath(file, baseFile, '/') ?: file.name
    }

    // --- diff ---------------------------------------------------------------

    /** (item, null) on success, (null, reason) otherwise. */
    private fun collectDiff(): Pair<ContextItem?, String?> {
        // runCatching (Throwable): in an IDE without the VCS module the
        // service is absent, and git is still worth trying.
        val hasVcs = runCatching { ProjectLevelVcsManager.getInstance(project).hasActiveVcss() }.getOrDefault(false)
        if (!hasVcs) return gitDiffFallback()

        val changes = ChangeListManager.getInstance(project).allChanges.toList()
        if (changes.isEmpty()) return Pair(null, "No uncommitted changes.")

        val out = StringBuilder()
        var files = 0
        var truncated = false
        for (change in changes.sortedBy { pathOf(it) }) {
            if (out.length > CONTEXT_ITEM_MAX_CHARS) {
                truncated = true
                break
            }
            out.append(renderChange(change))
            files += 1
        }
        val (text, cut) = truncateForContext(out.toString())
        val label = diffLabel(changes.size)
        return Pair(ContextItem("diff", label, text, "diff", cut || truncated || files < changes.size), null)
    }

    private fun pathOf(change: Change): String {
        val revision = change.afterRevision ?: change.beforeRevision ?: return ""
        val path = revision.file.path
        val base = project.basePath
        return if (base != null && path.startsWith("$base/")) path.substring(base.length + 1) else path
    }

    private fun renderChange(change: Change): String {
        val path = pathOf(change)
        val before = change.beforeRevision
        val after = change.afterRevision
        if (before is BinaryContentRevision || after is BinaryContentRevision) {
            return "--- a/$path\n+++ b/$path\nBinary file changed\n"
        }
        val beforeText = contentOf(before)
        val afterText = contentOf(after)
        if ((before != null && beforeText == null) || (after != null && afterText == null)) {
            return "--- a/$path\n+++ b/$path\n(content could not be read)\n"
        }
        val movedFrom = before?.file?.path
        val movedTo = after?.file?.path
        val header = if (movedFrom != null && movedTo != null && movedFrom != movedTo) "rename from $movedFrom\nrename to $movedTo\n" else ""
        val ranges = if (beforeText != null && afterText != null) {
            runCatching {
                ComparisonManager.getInstance()
                    .compareLines(beforeText, afterText, ComparisonPolicy.DEFAULT, EmptyProgressIndicator())
                    .map { LineRange(it.startLine1, it.endLine1, it.startLine2, it.endLine2) }
            }.getOrElse {
                // DiffTooBigException and friends: say so rather than dump both files.
                return header + "--- a/$path\n+++ b/$path\n(changed; too large to diff here)\n"
            }
        } else {
            null
        }
        return header + unifiedDiff(path, beforeText, afterText, ranges)
    }

    private fun contentOf(revision: ContentRevision?): String? =
        if (revision == null) null else runCatching { revision.content }.getOrNull()

    // --- gitlog -------------------------------------------------------------

    private fun gitRoot(): File? {
        // The IDE's own Git root first (a project can hold its repository in a
        // sub-folder); runCatching because the VCS module may be absent.
        val vcsRoot = runCatching {
            ProjectLevelVcsManager.getInstance(project).allVcsRoots
                .firstOrNull { it.vcs?.name.equals("Git", ignoreCase = true) }
                ?.path?.path
        }.getOrNull()
        if (vcsRoot != null) return File(vcsRoot)
        val base = project.basePath ?: return null
        return findGitRoot(File(base))
    }

    /** (item, null) on success, (null, reason) otherwise. */
    private fun collectGitLog(): Pair<ContextItem?, String?> {
        val root = gitRoot()
            ?: return Pair(null, "This project is not in a git repository, so there are no commits to attach.")
        val command = GeneralCommandLine(listOf("git") + GIT_LOG_ARGS)
            .withWorkDirectory(root)
            .withCharset(StandardCharsets.UTF_8)
        val output = try {
            CapturingProcessHandler(command).runProcess(15_000)
        } catch (e: Exception) {
            return Pair(null, "git could not be started: ${e.message}")
        }
        if (output.isTimeout) return Pair(null, "git log took longer than 15 seconds.")
        if (output.exitCode != 0) {
            val err = output.stderr.trim()
            // A repository with no commits yet exits non-zero with this message.
            if (err.contains("does not have any commits")) return Pair(null, "This repository has no commits yet.")
            return Pair(null, "git log failed: " + err.ifEmpty { "exit code ${output.exitCode}" })
        }
        val commits = parseGitLog(output.stdout)
        if (commits.isEmpty()) return Pair(null, "This repository has no commits yet.")
        val (text, cut) = formatGitLog(commits)
        return Pair(ContextItem("gitlog", gitLogLabel(commits.size), text, null, cut), null)
    }

    private fun gitDiffFallback(): Pair<ContextItem?, String?> {
        val base = project.basePath ?: return Pair(null, "The project has no root folder.")
        if (!File(base, ".git").exists()) {
            return Pair(null, "No version control is configured for this project, and its root is not a git repository.")
        }
        val command = GeneralCommandLine("git", "diff", "HEAD", "--no-color", "--no-ext-diff")
            .withWorkDirectory(base)
            .withCharset(StandardCharsets.UTF_8)
        val output = try {
            CapturingProcessHandler(command).runProcess(15_000)
        } catch (e: Exception) {
            return Pair(null, "git could not be started: ${e.message}")
        }
        if (output.isTimeout) return Pair(null, "git diff took longer than 15 seconds.")
        if (output.exitCode != 0) {
            return Pair(null, "git diff failed: " + output.stderr.trim().ifEmpty { "exit code ${output.exitCode}" })
        }
        val diff = output.stdout
        if (diff.isBlank()) return Pair(null, "No uncommitted changes.")
        val (text, cut) = truncateForContext(diff)
        return Pair(ContextItem("diff", diffLabel(countGitDiffFiles(diff)), text, "diff", cut), null)
    }
}
