// Tools > VegaDuta > Run Workflow: load workflows in the background, show a
// chooser popup, optionally take an input string, then run + poll with a
// cancellable progress task until a terminal status (COMPLETED/FAILED/
// CANCELLED) or a 10-minute deadline.

package ai.vegaduta.ide.actions

import ai.vegaduta.ide.api.ApiClient
import ai.vegaduta.ide.privacy.HostedOperation
import ai.vegaduta.ide.privacy.PrivateModePolicy
import ai.vegaduta.ide.settings.VegadutaSettingsState
import ai.vegaduta.ide.api.TERMINAL_RUN_STATUSES
import ai.vegaduta.ide.api.WorkflowSummary
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.SimpleListCellRenderer

class RunWorkflowAction : AnAction(), DumbAware {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        // Private Mode: say so up front instead of asking for input that
        // ApiClient.runWorkflow would then refuse to send.
        PrivateModePolicy.blockReason(VegadutaSettingsState.getInstance().privateMode, HostedOperation.WORKFLOW_RUN)?.let {
            notify(project, it, NotificationType.WARNING)
            return
        }
        object : Task.Backgroundable(project, "Loading VegaDuta workflows", true) {
            private var workflows: List<WorkflowSummary> = emptyList()

            override fun run(indicator: ProgressIndicator) {
                workflows = service<ApiClient>().listWorkflows()
            }

            override fun onSuccess() {
                if (workflows.isEmpty()) {
                    notify(project, "No workflows found for this account.", NotificationType.INFORMATION)
                    return
                }
                JBPopupFactory.getInstance()
                    .createPopupChooserBuilder(workflows)
                    .setTitle("Run VegaDuta Workflow")
                    .setRenderer(SimpleListCellRenderer.create("") { it.name })
                    .setItemChosenCallback { workflow ->
                        val input = Messages.showMultilineInputDialog(
                            project,
                            "Input for \"${workflow.name}\" (optional):",
                            "Run Workflow",
                            "",
                            null,
                            null
                        ) ?: return@setItemChosenCallback // cancelled
                        runAndPoll(project, workflow, input)
                    }
                    .createPopup()
                    .showCenteredInCurrentWindow(project)
            }

            override fun onThrowable(error: Throwable) {
                notify(project, "Could not load workflows: ${error.message}", NotificationType.ERROR)
            }
        }.queue()
    }

    private fun runAndPoll(project: Project, workflow: WorkflowSummary, input: String) {
        object : Task.Backgroundable(project, "Running workflow: ${workflow.name}", true) {
            override fun run(indicator: ProgressIndicator) {
                val api = service<ApiClient>()
                var run = api.runWorkflow(workflow.id, input)
                val deadline = System.currentTimeMillis() + 10 * 60_000
                while (run.status !in TERMINAL_RUN_STATUSES && System.currentTimeMillis() < deadline) {
                    indicator.checkCanceled()
                    indicator.text = "Status: ${run.status}"
                    Thread.sleep(2000)
                    run = api.getWorkflowRun(workflow.id, run.id)
                }
                val message = when {
                    run.status == "COMPLETED" ->
                        "Workflow \"${workflow.name}\" completed." +
                            (run.outputFileName?.let { " Output: $it" } ?: "")
                    run.status in TERMINAL_RUN_STATUSES ->
                        "Workflow \"${workflow.name}\" ${run.status.lowercase()}." +
                            (run.errorMessage?.let { " $it" } ?: "")
                    else ->
                        "Workflow \"${workflow.name}\" is still running - check the web console for the result."
                }
                val type = if (run.status == "COMPLETED" || run.status !in TERMINAL_RUN_STATUSES) {
                    NotificationType.INFORMATION
                } else {
                    NotificationType.WARNING
                }
                notify(project, message, type)
            }

            override fun onThrowable(error: Throwable) {
                notify(project, "Workflow run failed: ${error.message}", NotificationType.ERROR)
            }
        }.queue()
    }

    private fun notify(project: Project, message: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("VegaDuta")
            .createNotification(message, type)
            .notify(project)
    }
}
