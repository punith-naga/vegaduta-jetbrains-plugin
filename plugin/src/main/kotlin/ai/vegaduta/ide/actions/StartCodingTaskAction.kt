// Tools > VegaDuta > Start a Coding Task - the action that turns this plugin
// from a chat client into an agent. The JetBrains equivalent of
// clients/vscode/src/agent/runTask.ts, and it should stay behaviourally
// identical: same prompt, same convention files, same failure explanations.
//
// The whole path is local and free by construction: an OpenAI-compatible server
// the user already runs, or a key they own. Nothing here calls the VegaDuta
// platform, needs an account, or spends a quota - so this action does not check
// TokenStore.isSignedIn() and must not start doing so. The hosted platform
// stays the paid/team path (chat, workflows, code-intel); it is not on this
// road.
//
// Threading: everything after the input dialog runs in a Task.Backgroundable,
// because the loop, the model transport and run_command all block. Cancelling
// that task sets one AtomicBoolean, which is the single cancellation signal the
// whole agent package reads - the loop between steps, the HTTP transport while
// a request is in flight, and ProjectToolExecutor while a command is running.

package ai.vegaduta.ide.actions

import ai.vegaduta.ide.agent.AgentEvent
import ai.vegaduta.ide.agent.AgentFailure
import ai.vegaduta.ide.agent.AgentFailureReason
import ai.vegaduta.ide.agent.AgentMessage
import ai.vegaduta.ide.agent.AgentRunSuccess
import ai.vegaduta.ide.agent.ApprovalGate
import ai.vegaduta.ide.agent.ApprovalKind
import ai.vegaduta.ide.agent.DEFAULT_LOCAL_BASE_URL
import ai.vegaduta.ide.agent.OpenAiCompatibleModel
import ai.vegaduta.ide.agent.OpenAiCompatibleOptions
import ai.vegaduta.ide.agent.ProjectToolExecutor
import ai.vegaduta.ide.agent.SystemPromptContext
import ai.vegaduta.ide.agent.TOOL_CAPABLE_MODEL_IDS
import ai.vegaduta.ide.agent.buildCodingSystemPrompt
import ai.vegaduta.ide.agent.describeWithinRoot
import ai.vegaduta.ide.agent.discoverLocalEndpoint
import ai.vegaduta.ide.privacy.HostedOperation
import ai.vegaduta.ide.privacy.PrivateModePolicy
import ai.vegaduta.ide.agent.localEndpointHints
import ai.vegaduta.ide.agent.runAgentLoop
import ai.vegaduta.ide.auth.TokenStore
import ai.vegaduta.ide.settings.VegadutaSettingsState
import ai.vegaduta.ide.toolwindow.AgentConsole
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.util.concurrency.AppExecutorUtil
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val DIALOG_TITLE = "VegaDuta Coding Task"

/** Files that, when present, tell the agent how this project expects to be
 * worked in. Read in order; the first two that exist are included. Same list
 * and same cap as runTask.ts. */
private val CONVENTION_FILES = listOf("AGENTS.md", "CLAUDE.md", ".cursorrules", "CONTRIBUTING.md")
private const val MAX_CONVENTION_CHARS = 4_000

/** How often the background task's cancel state is copied onto the flag the
 * agent package reads. A ProgressIndicator cannot be observed any other way,
 * and polling it only between steps would leave a cancel unheard for the whole
 * of a model call or a two-minute test run. */
private const val CANCEL_POLL_MS = 150L

private const val MAX_TOOL_ARGS_CHARS = 180
private const val MAX_TOOL_ERROR_CHARS = 300
private const val MAX_NOTIFICATION_CHARS = 200

class StartCodingTaskAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val root = projectRoot(project)
        if (root == null) {
            Messages.showWarningDialog(
                project,
                "The agent works inside a project directory, and this project does not have one on disk. " +
                    "Open a folder and try again.",
                DIALOG_TITLE,
            )
            return
        }

        val task = Messages.showMultilineInputDialog(
            project,
            "What should the agent do? It can read, search, edit and run commands in this project.\n" +
                "Example: the date parser drops timezones - find why and fix it, then run the tests.",
            DIALOG_TITLE,
            "",
            null,
            null,
        )?.trim().orEmpty()
        if (task.isEmpty()) return

        // Read on the EDT, before the background task starts: selectedFiles is
        // UI state.
        val activeFile = activeFileLabel(project, root)

        val console = project.service<AgentConsole>()
        console.clear()
        console.activate()

        AgentRunTask(project, root, task, activeFile, console).queue()
    }
}

private class AgentRunTask(
    private val ideProject: Project,
    private val root: Path,
    private val task: String,
    private val activeFile: String?,
    private val console: AgentConsole,
) : Task.Backgroundable(ideProject, "VegaDuta agent", true) {

    override fun run(indicator: ProgressIndicator) {
        val settings = VegadutaSettingsState.getInstance()
        val cancelled = AtomicBoolean(false)
        val watcher = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(
            { if (indicator.isCanceled) cancelled.set(true) },
            0,
            CANCEL_POLL_MS,
            TimeUnit.MILLISECONDS,
        )

        try {
            indicator.text = "Looking for a model"
            // A blank setting is the zero-config path: probe the ports the three
            // local inference products pin, and fall back to the adapter's own
            // default so the failure message is about Ollama rather than about a
            // setting the user never filled in.
            val configured = settings.agentBaseUrlOrNull()
            // Private Mode: the task, files and command output the agent reads
            // may only go to a model on this machine. Discovery (configured ==
            // null) probes 127.0.0.1 only, so it stays allowed.
            if (!PrivateModePolicy.agentEndpointAllowed(settings.privateMode, configured)) {
                val reason = PrivateModePolicy.blockReason(true, HostedOperation.REMOTE_AGENT_MODEL)
                console.error("Not started: $reason (Agent endpoint: $configured)")
                notify("Private Mode is on and the agent endpoint is not on this machine - the task was not started.", NotificationType.WARNING)
                return
            }
            val discovered = if (configured == null) discoverLocalEndpoint(cancelled = cancelled) else null
            val baseUrl = configured ?: discovered?.baseUrl

            val model = OpenAiCompatibleModel(
                OpenAiCompatibleOptions(
                    baseUrl = baseUrl,
                    apiKey = service<TokenStore>().agentApiKey(),
                    model = settings.agentModelOrNull(),
                )
            )

            console.system("Task: $task")
            console.system("Project: $root")
            console.system("Model: ${model.id}${discovered?.let { " (found ${it.label})" }.orEmpty()}")
            console.system("")

            val approvals = ApprovalGate(
                ideProject,
                mapOf(
                    ApprovalKind.EDIT to settings.agentAutoApproveEdits,
                    ApprovalKind.COMMAND to settings.agentAutoApproveCommands,
                ),
            )
            val executor = ProjectToolExecutor(ideProject, root, approvals) { console.line("  $it") }

            val messages = listOf(
                AgentMessage.System(
                    buildCodingSystemPrompt(
                        SystemPromptContext(
                            workspaceName = ideProject.name,
                            projectNotes = readConventions(root),
                            activeFile = activeFile,
                        )
                    )
                ),
                AgentMessage.User(task),
            )

            val result = runAgentLoop(
                model = model,
                executor = executor,
                messages = messages,
                maxSteps = settings.agentMaxStepsBounded(),
                cancelled = cancelled,
                onEvent = { event -> report(event, indicator) },
            )

            console.system("")
            when (result) {
                is AgentRunSuccess -> {
                    console.system("Done in ${result.stepsUsed} step(s).")
                    // The agent's own summary is the answer and the console
                    // already holds the trace, so the balloon stays to one line.
                    val headline = result.answer.trim().lineSequence()
                        .firstOrNull { it.isNotBlank() }
                        ?.take(MAX_NOTIFICATION_CHARS)
                    notify(headline ?: "VegaDuta agent finished.", NotificationType.INFORMATION)
                }

                is AgentFailure -> {
                    console.error("Stopped: ${result.reason.wire}${result.detail?.let { " - $it" }.orEmpty()}")
                    val nothingFound = configured == null && discovered == null
                    val message = if (approvals.wasCancelled) {
                        "Stopped at your request."
                    } else {
                        explainFailure(result, baseUrl ?: DEFAULT_LOCAL_BASE_URL, nothingFound)
                    }
                    notify(message, NotificationType.WARNING)
                }
            }
        } finally {
            watcher.cancel(false)
        }
    }

    override fun onThrowable(error: Throwable) {
        // Nothing in the agent package throws by contract, so reaching here is a
        // bug worth showing rather than a failure worth explaining.
        console.error("The agent run failed unexpectedly: ${error.message ?: error.toString()}")
        notify("VegaDuta agent failed unexpectedly - see the VegaDuta Agent tool window.", NotificationType.ERROR)
    }

    private fun report(event: AgentEvent, indicator: ProgressIndicator) {
        when (event) {
            is AgentEvent.Step -> indicator.text = "Step ${event.index} of ${event.of}"
            is AgentEvent.Assistant -> console.line(event.content)
            is AgentEvent.ToolStart -> {
                indicator.text2 = event.call.name
                console.system("> ${event.call.name} ${event.call.args.toString().take(MAX_TOOL_ARGS_CHARS)}")
            }

            is AgentEvent.ToolEnd -> {
                if (event.outcome.failed) console.error("  ! ${event.outcome.content.take(MAX_TOOL_ERROR_CHARS)}")
            }

            is AgentEvent.Done -> indicator.text2 = ""
        }
    }

    private fun notify(message: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("VegaDuta")
            .createNotification(message, type)
            .notify(ideProject)
    }
}

/** Human-readable, actionable reasons - never a raw provider error. Mirrors
 * runTask.ts's explainFailure(), with this plugin's setting locations. */
private fun explainFailure(failure: AgentFailure, baseUrl: String, nothingDiscovered: Boolean): String =
    when (failure.reason) {
        AgentFailureReason.NO_MODEL -> {
            val where = if (nothingDiscovered) {
                "No local inference server answered on any of the well-known ports, and none is configured.\n" +
                    localEndpointHints()
            } else {
                "No model answered at $baseUrl."
            }
            "$where\nSet an endpoint and, for a hosted provider, a key in Settings | Tools | VegaDuta."
        }

        AgentFailureReason.NO_TOOL_SUPPORT ->
            "That model cannot call tools, so it cannot edit files. Pick a tool-calling model - " +
                "${TOOL_CAPABLE_MODEL_IDS.joinToString(", ")} all work locally."

        AgentFailureReason.STEP_BUDGET_EXCEEDED ->
            "The agent hit its step limit without finishing. Narrow the task, or raise the agent step " +
                "limit in Settings | Tools | VegaDuta."

        AgentFailureReason.ABORTED -> "Cancelled."

        AgentFailureReason.MODEL_REFUSED -> "The model declined to answer this request."

        else -> failure.detail?.let { "The model call failed: $it" } ?: "The model call failed."
    }

/**
 * The directory the agent is confined to. basePath rather than a guess over
 * content roots: the executor hands this path to a shell and resolves every
 * model-supplied path against it, so it has to be one real local directory the
 * user would recognise as "this project", not whichever root happened to sort
 * first.
 */
private fun projectRoot(project: Project): Path? {
    val base = project.basePath ?: return null
    val path = runCatching { Paths.get(base).toAbsolutePath().normalize() }.getOrNull() ?: return null
    return path.takeIf { Files.isDirectory(it) }
}

/** The open file as a project-relative path, or null when nothing is open or it
 * lives outside the root - an absolute path outside the project would only
 * invite the model to ask for a file the executor will refuse. */
private fun activeFileLabel(project: Project, root: Path): String? {
    val file = FileEditorManager.getInstance(project).selectedFiles.firstOrNull() ?: return null
    val nio = runCatching { file.toNioPath().toAbsolutePath().normalize() }.getOrNull() ?: return null
    return if (nio.startsWith(root)) describeWithinRoot(root, nio) else null
}

/** Read off the disk, not the VFS: this runs on a background thread before the
 * loop starts, and an unreadable or absent conventions file is the common case
 * rather than an error. */
private fun readConventions(root: Path): String {
    val found = mutableListOf<String>()
    for (name in CONVENTION_FILES) {
        if (found.size >= 2) break
        val path = root.resolve(name)
        if (!Files.isRegularFile(path)) continue
        val text = runCatching { String(Files.readAllBytes(path), StandardCharsets.UTF_8) }.getOrNull() ?: continue
        found += "--- $name ---\n${text.take(MAX_CONVENTION_CHARS)}"
    }
    return found.joinToString("\n\n")
}
