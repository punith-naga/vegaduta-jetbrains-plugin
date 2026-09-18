// The write half of the webview contract: ui.insert, ui.newFile,
// ui.setCommitMessage and ui.reveal. The editor work runs on the EDT, and every
// failure path is typed - the person is told what happened (and the text is on the clipboard)
// instead of a click that silently does nothing.

package ai.vegaduta.ide.context

import com.intellij.ide.scratch.ScratchRootType
import com.intellij.lang.Language
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.openapi.fileTypes.PlainTextLanguage
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vcs.CommitMessageI
import com.intellij.testFramework.LightVirtualFile
import java.awt.Component
import java.awt.datatransfer.StringSelection
import java.lang.ref.WeakReference
import java.nio.file.Paths

/**
 * The commit-message box the person last asked us to fill. Captured by
 * GenerateCommitMessageAction from VcsDataKeys.COMMIT_MESSAGE_CONTROL - the
 * one public handle on that box - and held weakly so a closed commit dialog
 * can be collected.
 */
@Service(Service.Level.PROJECT)
class CommitMessageTarget(@Suppress("unused") private val project: Project) {
    @Volatile private var ref: WeakReference<CommitMessageI>? = null

    fun remember(control: CommitMessageI) {
        ref = WeakReference(control)
    }

    /** The captured box, or null when there is none or it has left the UI. */
    fun current(): CommitMessageI? {
        val control = ref?.get() ?: return null
        if (control is Component && !control.isDisplayable) return null
        return control
    }
}

object HostEditorOps {
    private val log = logger<HostEditorOps>()

    fun insert(project: Project, text: String) {
        if (text.isEmpty()) return
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val editor = FileEditorManager.getInstance(project).selectedTextEditor
            if (editor == null) {
                copyAndTell(project, text, "No file is open in the editor, so the code was copied to the clipboard instead.")
                return@invokeLater
            }
            if (!editor.document.isWritable) {
                copyAndTell(project, text, "The open file is read-only, so the code was copied to the clipboard instead.")
                return@invokeLater
            }
            WriteCommandAction.runWriteCommandAction(project, "Insert from VegaDuta", null, {
                val selection = editor.selectionModel
                if (selection.hasSelection()) {
                    // Replace what the person selected - the usual reason to
                    // insert an answer about a selection is to swap it in.
                    editor.document.replaceString(selection.selectionStart, selection.selectionEnd, text)
                    selection.removeSelection()
                } else {
                    editor.document.insertString(editor.caretModel.offset, text)
                }
            })
        }
    }

    /** Opens [text] in a new scratch file (persisted under Scratches and
     * Consoles, so it survives a restart and can be saved elsewhere). Falls
     * back to an in-memory editor tab if a scratch cannot be created. */
    fun newFile(project: Project, text: String, languageId: String?) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val ext = extensionForLanguageId(languageId)
            val fileType = FileTypeManager.getInstance().getFileTypeByExtension(ext)
            val language: Language = (fileType as? LanguageFileType)?.language ?: PlainTextLanguage.INSTANCE
            val scratch = runCatching {
                ScratchRootType.getInstance().createScratchFile(project, "vegaduta.$ext", language, text)
            }.onFailure { log.info("scratch file creation failed", it) }.getOrNull()
            val file = scratch ?: LightVirtualFile("vegaduta.$ext", fileType, text)
            FileEditorManager.getInstance(project).openFile(file, true)
        }
    }

    fun setCommitMessage(project: Project, text: String) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val control = project.service<CommitMessageTarget>().current()
            if (control == null) {
                copyAndTell(
                    project, text,
                    "Commit message copied to the clipboard. To have VegaDuta fill the box directly, open the " +
                        "Commit tool window and use the VegaDuta button in the commit message toolbar.",
                )
                return@invokeLater
            }
            control.setCommitMessage(text)
            notify(project, "Commit message filled in. Review it before you commit - VegaDuta never commits for you.", NotificationType.INFORMATION)
        }
    }

    /**
     * ui.reveal (Code Tour): open [path] - project-relative, or null for the
     * active editor - and select lines [startLine]..[endLine] (1-based,
     * inclusive, clamped to the file). The path comes from a model's answer,
     * so resolveRevealPath refuses anything outside the project, symlinks
     * included. Resolution and the VFS lookup (which may refresh) run on a
     * pooled thread; the editor work on the EDT.
     */
    fun reveal(project: Project, path: String?, startLine: Int, endLine: Int) {
        ApplicationManager.getApplication().executeOnPooledThread {
            if (project.isDisposed) return@executeOnPooledThread
            val file: VirtualFile? = if (path.isNullOrBlank()) {
                null
            } else {
                val base = project.basePath
                if (base == null) {
                    notifyPlain(project, "This project has no root folder, so $path could not be opened.", NotificationType.WARNING)
                    return@executeOnPooledThread
                }
                when (val target = resolveRevealPath(Paths.get(base), path)) {
                    is RevealPath.Refused -> {
                        log.info("ui.reveal refused: ${target.reason}")
                        notifyPlain(project, target.reason, NotificationType.WARNING)
                        return@executeOnPooledThread
                    }
                    is RevealPath.Inside -> {
                        val found = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target.path)
                        if (found == null || found.isDirectory) {
                            notifyPlain(project, "$path was not found in this project.", NotificationType.WARNING)
                            return@executeOnPooledThread
                        }
                        found
                    }
                }
            }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val manager = FileEditorManager.getInstance(project)
                val editor = if (file == null) {
                    manager.selectedTextEditor
                } else {
                    manager.openTextEditor(OpenFileDescriptor(project, file), true)
                }
                if (editor == null) {
                    notifyPlain(
                        project,
                        if (file == null) "No file is open in the editor to show those lines in."
                        else "${file.name} could not be opened as text.",
                        NotificationType.WARNING,
                    )
                    return@invokeLater
                }
                val document = editor.document
                val range = revealLineRange(startLine, endLine, document.lineCount) ?: return@invokeLater
                val start = document.getLineStartOffset(range.first)
                val end = document.getLineEndOffset(range.second)
                editor.caretModel.moveToOffset(start)
                editor.selectionModel.setSelection(start, end)
                editor.scrollingModel.scrollToCaret(ScrollType.CENTER)
            }
        }
    }

    /** A notification whose text may contain untrusted input (a path from a
     * model's answer): notification content is HTML, so it is escaped. */
    private fun notifyPlain(project: Project, message: String, type: NotificationType) {
        notify(project, StringUtil.escapeXmlEntities(message), type)
    }

    fun copyAndTell(project: Project, text: String, message: String) {
        CopyPasteManager.getInstance().setContents(StringSelection(text))
        notify(project, message, NotificationType.INFORMATION)
    }

    fun notify(project: Project, message: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("VegaDuta")
            .createNotification(message, type)
            .notify(project)
    }
}
