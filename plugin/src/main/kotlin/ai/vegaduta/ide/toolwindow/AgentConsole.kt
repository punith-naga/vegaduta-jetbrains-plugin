// The coding agent's trace surface: a bottom tool window holding one console
// per project, equivalent to the VS Code extension's "VegaDuta Agent" output
// channel.
//
// Why a console and not the chat tool window: the chat surface is the shared
// webview, and piping a local, account-free agent run through a page built for
// hosted tenant chat would blur exactly the line this feature depends on -
// nothing in an agent run touches the platform. A console also gives the user
// the platform's own scrollback, search and copy for free.
//
// Thread contract: the console is created on the EDT (this class hops there
// itself), and printing afterwards is safe from any thread - which matters,
// because every line here is emitted by the agent's background task.

package ai.vegaduta.ide.toolwindow

import ai.vegaduta.ide.agent.localEndpointHints
import com.intellij.execution.filters.HyperlinkInfo
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import java.util.concurrent.atomic.AtomicReference

const val AGENT_TOOL_WINDOW_ID = "VegaDuta Agent"

/** plugin.xml's id for Tools > VegaDuta > Start a Coding Task. */
private const val START_TASK_ACTION_ID = "VegaDuta.StartCodingTask"

@Service(Service.Level.PROJECT)
class AgentConsole(private val project: Project) : Disposable {

    @Volatile
    private var view: ConsoleView? = null

    /** Created lazily and reused: the tool window factory and the action both
     * want the same console, whichever of them runs first. */
    fun console(): ConsoleView {
        view?.let { return it }
        val holder = AtomicReference<ConsoleView>()
        // Runs inline when the caller is already on the EDT, which the factory
        // and the action both are.
        ApplicationManager.getApplication().invokeAndWait { holder.set(createOnEdt()) }
        return holder.get()
    }

    private fun createOnEdt(): ConsoleView {
        view?.let { return it }
        val created = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
        Disposer.register(this, created)
        view = created
        printWelcome(created)
        return created
    }

    /** The empty state. Before the first run this window used to be a blank
     * black panel, which read as "the plugin is broken". Now it says what the
     * agent is, what it needs, and offers the two next steps as links. */
    private fun printWelcome(c: ConsoleView) {
        val sys = ConsoleViewContentType.SYSTEM_OUTPUT
        val out = ConsoleViewContentType.NORMAL_OUTPUT
        c.print("VegaDuta Agent\n", sys)
        c.print("==============\n\n", sys)
        c.print(
            "A coding agent that works inside this project: it reads and searches your code,\n" +
                "edits files and runs commands, step by step - and asks you before each edit\n" +
                "and each command. Its live trace appears here.\n\n",
            out,
        )
        c.print(
            "It runs on YOUR model, so it is free and needs no VegaDuta account:\n" +
                localEndpointHints() + "\n" +
                "- or an OpenAI-compatible API key you own (set it in the settings).\n\n",
            out,
        )
        c.print("  ", out)
        c.printHyperlink("> Start a coding task", HyperlinkInfo { runAction(START_TASK_ACTION_ID) })
        c.print("      ", out)
        c.printHyperlink("Set up your model", HyperlinkInfo { openSettings() })
        c.print("\n\n", out)
        c.print("Also: Tools > VegaDuta > Start a Coding Task..., or the play button in this window's title bar.\n", sys)
    }

    private fun runAction(id: String) {
        val action: AnAction = ActionManager.getInstance().getAction(id) ?: return
        ActionUtil.invokeAction(action, SimpleDataContext.getProjectContext(project), ActionPlaces.TOOLWINDOW_CONTENT, null, null)
    }

    private fun openSettings() {
        ShowSettingsUtil.getInstance().showSettingsDialog(project, "VegaDuta")
    }

    fun clear() {
        console().clear()
    }

    fun line(text: String) {
        console().print("$text\n", ConsoleViewContentType.NORMAL_OUTPUT)
    }

    /** Run metadata and step boundaries - the bits that are the plugin talking,
     * not the model. */
    fun system(text: String) {
        console().print("$text\n", ConsoleViewContentType.SYSTEM_OUTPUT)
    }

    fun error(text: String) {
        console().print("$text\n", ConsoleViewContentType.ERROR_OUTPUT)
    }

    /** Brings the tool window up without stealing focus from the editor. */
    fun activate() {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            ToolWindowManager.getInstance(project).getToolWindow(AGENT_TOOL_WINDOW_ID)?.activate(null, false)
        }
    }

    override fun dispose() {
        // The ConsoleView is a registered child; Disposer handles it.
    }
}

class AgentConsoleToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val console = project.service<AgentConsole>().console()
        val content = ContentFactory.getInstance().createContent(console.component, "", false)
        // The console outlives its tab: closing it would dispose a view the
        // service still hands out.
        content.isCloseable = false
        toolWindow.contentManager.addContent(content)
        // A visible way in, even after a run has replaced the welcome text.
        ActionManager.getInstance().getAction(START_TASK_ACTION_ID)?.let { toolWindow.setTitleActions(listOf(it)) }
    }
}
