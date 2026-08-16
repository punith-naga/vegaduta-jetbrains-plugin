// Editor-selection actions: grab the selection, open the VegaDuta tool
// window, and hand the text to whichever chat surface is active (JCEF posts
// a selection.context message that prefills the composer; the Swing fallback
// prefills its input field).

package ai.vegaduta.ide.actions

import ai.vegaduta.ide.toolwindow.ChatSurfaceRegistry
import ai.vegaduta.ide.toolwindow.TOOL_WINDOW_ID
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.wm.ToolWindowManager

abstract class SelectionToChatAction(private val instruction: String) : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val text = editor.selectionModel.selectedText?.takeIf { it.isNotBlank() } ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val languageId = file?.fileType?.name?.lowercase()
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID) ?: return
        // activate() runs the callback after the tool window content (and so
        // the ChatSurfaceRegistry entry) exists.
        toolWindow.activate({
            project.service<ChatSurfaceRegistry>().active
                ?.sendSelection("$instruction\n\n$text", languageId, file?.name)
        }, true)
    }
}

class ExplainSelectionAction : SelectionToChatAction("Explain this code:")

class RefactorSelectionAction : SelectionToChatAction("Refactor this code and explain the changes:")
