// One-click prompts. Each action opens the VegaDuta tool window and stages a
// prompt through ui.prefill (clients/shared/src/webview/protocol.ts): the text
// goes into the composer, the chat app asks this host for the listed context
// (context.request -> IdeContextCollector), and the prompt is sent once it
// arrives. Whether it then goes to a hosted agent or to the person's own local
// server is the chat panel's choice, so these work signed in AND signed out.

package ai.vegaduta.ide.actions

import ai.vegaduta.ide.context.CommitMessageTarget
import ai.vegaduta.ide.toolwindow.ChatSurfaceRegistry
import ai.vegaduta.ide.toolwindow.TOOL_WINDOW_ID
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.openapi.wm.ToolWindowManager

/** The prompt texts, kept together so the README can quote them honestly. */
object PrefillPrompts {
    const val REVIEW_CHANGES =
        "Review my uncommitted changes in the attached diff. List real problems first - bugs, " +
            "anything that will not compile or will break at runtime, security issues, missing tests - " +
            "each with the file and line. Then smaller suggestions. If it looks good, say so plainly."

    const val COMMIT_MESSAGE =
        "/commit Write a commit message for the attached diff: a summary line under 72 characters " +
            "in the imperative mood, a blank line, then a short body saying what changed and why. " +
            "Reply with the commit message only."

    const val WRITE_TESTS =
        "Write unit tests for the attached selection, using the test framework and style this " +
            "file's project already uses. Cover the normal path, edge cases and error handling. " +
            "Reply with complete, runnable test code."

    const val ADD_DOCS =
        "Add documentation comments to the attached selection in this language's standard style " +
            "(KDoc, Javadoc, docstrings, JSDoc, ...). Do not change any behaviour. Reply with the " +
            "complete documented code so it can replace the selection."
}

abstract class PrefillAction(
    private val prompt: String,
    private val context: List<String>,
    private val needsSelection: Boolean,
) : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabledAndVisible = project != null && (
            !needsSelection || e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
            )
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        beforePrefill(e, project)
        openChatAndPrefill(project, prompt, context, send = true)
    }

    protected open fun beforePrefill(e: AnActionEvent, project: Project) = Unit
}

fun openChatAndPrefill(project: Project, prompt: String, context: List<String>, send: Boolean) {
    val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID) ?: return
    // activate() runs the callback after the tool window content (and so the
    // ChatSurfaceRegistry entry) exists. The JCEF bridge queues the prefill
    // until the page has booted and received init.
    toolWindow.activate({
        project.service<ChatSurfaceRegistry>().active?.prefill(prompt, context, send)
    }, true)
}

class ReviewChangesAction : PrefillAction(PrefillPrompts.REVIEW_CHANGES, listOf("diff"), needsSelection = false)

/**
 * Registered twice: in the VegaDuta menus, and in Vcs.MessageActionGroup - the
 * toolbar above the commit message box. Invoked from that toolbar it captures
 * VcsDataKeys.COMMIT_MESSAGE_CONTROL, so the answer's "Use as commit message"
 * (ui.setCommitMessage) can write straight into that box. Invoked from a menu
 * there is no box in reach; the host then uses the last captured one, or
 * copies the message and says so (HostEditorOps.setCommitMessage).
 */
class GenerateCommitMessageAction : PrefillAction(PrefillPrompts.COMMIT_MESSAGE, listOf("diff"), needsSelection = false) {
    override fun beforePrefill(e: AnActionEvent, project: Project) {
        e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL)?.let { project.service<CommitMessageTarget>().remember(it) }
    }
}

class WriteTestsAction : PrefillAction(PrefillPrompts.WRITE_TESTS, listOf("selection", "file"), needsSelection = true)

class AddDocsAction : PrefillAction(PrefillPrompts.ADD_DOCS, listOf("selection"), needsSelection = true)
