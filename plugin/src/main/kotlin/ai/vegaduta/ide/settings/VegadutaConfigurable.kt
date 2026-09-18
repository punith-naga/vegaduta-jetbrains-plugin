// Settings | Tools | VegaDuta: environment picker (staging | production |
// custom bases), the local-inference server, the coding agent, plus Sign in /
// Sign out / Paste API key. Auth actions and both "set a key" buttons apply
// immediately (they are not part of the modified/apply cycle - the environment,
// local-inference and agent fields are).
//
// Neither API key has a field here, and neither ever will: settings sync
// between machines and appear in screen shares. Both live in PasswordSafe.

package ai.vegaduta.ide.settings

import ai.vegaduta.ide.agent.DEFAULT_MAX_STEPS
import ai.vegaduta.ide.agent.discoverLocalEndpoint
import ai.vegaduta.ide.agent.localEndpointHints
import ai.vegaduta.ide.auth.DeviceFlowLoginService
import ai.vegaduta.ide.auth.TokenStore
import ai.vegaduta.ide.completions.LocalCompletionEngine
import ai.vegaduta.ide.runtime.BundledRuntimeListener
import ai.vegaduta.ide.runtime.BundledRuntimeService
import ai.vegaduta.ide.runtime.CATALOG_MODELS
import ai.vegaduta.ide.runtime.RECOMMENDED_MODEL
import ai.vegaduta.ide.runtime.RuntimeState
import ai.vegaduta.ide.runtime.RuntimeStatusSnapshot
import ai.vegaduta.ide.runtime.catalogModel
import ai.vegaduta.ide.runtime.formatBytes
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.Messages
import com.intellij.ui.JBIntSpinner
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities

class VegadutaConfigurable : Configurable {

    private val environments = arrayOf(
        VegadutaSettingsState.ENV_STAGING,
        VegadutaSettingsState.ENV_PRODUCTION,
        VegadutaSettingsState.ENV_CUSTOM,
    )

    private var panel: JPanel? = null
    private val envCombo = ComboBox(environments)
    private val customApiField = JBTextField()
    private val customAuthField = JBTextField()
    private val statusLabel = JBLabel()

    // Local inference: the user's own OpenAI-compatible server. Blank URL =
    // off, and that is the shipped default - nothing is probed until it is
    // filled in.
    private val localBaseField = JBTextField().apply {
        emptyText.text = "blank = off; e.g. http://127.0.0.1:11434 (Ollama) or http://127.0.0.1:1234 (LM Studio)"
    }
    private val localModelField = JBTextField().apply {
        emptyText.text = "blank = the first model the server lists"
    }
    private val localCompletionsCheck =
        JBCheckBox("Code completions from the local server (press Ctrl+Space twice in the editor)")

    // Coding agent (Tools > VegaDuta > Start a Coding Task). Separate from the
    // completions server above on purpose: a user may well want a small fast
    // model completing lines and a larger tool-calling one doing tasks.
    private val agentBaseField = JBTextField().apply {
        emptyText.text = "blank = probe Ollama :11434, LM Studio :1234, llama.cpp :8080; or a provider origin"
    }
    private val agentModelField = JBTextField().apply {
        emptyText.text = "blank = the first model the server lists; it MUST support tool calling"
    }
    private val agentMaxStepsSpinner = JBIntSpinner(
        DEFAULT_MAX_STEPS,
        VegadutaSettingsState.AGENT_MIN_STEPS,
        VegadutaSettingsState.AGENT_MAX_STEPS,
    )
    private val agentAutoEditsCheck =
        JBCheckBox("Apply the agent's file edits without asking each time")
    private val agentAutoCommandsCheck =
        JBCheckBox("Run the agent's shell commands without asking each time")

    // Private Mode - the same flag the chat panel's toggle sets.
    private val privateModeCheck =
        JBCheckBox("Private Mode: keep prompts, code and attachments on this machine")

    // Bundled on-device model (ai.vegaduta.ide.runtime.BundledRuntimeService).
    // Acts at once, like the sign-in buttons - not part of apply().
    private val runtimeModelCombo = ComboBox(CATALOG_MODELS.map { it.displayName }.toTypedArray())
    private val runtimeRunButton = JButton("Download & run")
    private val runtimeStopButton = JButton("Stop")
    private val runtimeStatusLabel = JBLabel()
    private val runtimeListener = object : BundledRuntimeListener {
        override fun statusChanged(status: RuntimeStatusSnapshot) {
            SwingUtilities.invokeLater { showRuntimeStatus(status) }
        }

        // The runtime wrote localServerBaseUrl/Model directly. Refresh the two
        // fields, or pressing OK would write their stale text back over it.
        override fun localServerSettingsChanged() {
            SwingUtilities.invokeLater {
                val settings = VegadutaSettingsState.getInstance()
                localBaseField.text = settings.localServerBaseUrl
                localModelField.text = settings.localServerModel
            }
        }
    }

    private val authListener = Runnable { SwingUtilities.invokeLater { refreshStatus() } }

    override fun getDisplayName(): String = "VegaDuta"

    override fun createComponent(): JComponent {
        val signIn = JButton("Sign in…").apply {
            addActionListener {
                // Apply any pending environment change first so the device flow
                // targets the Keycloak the user just picked.
                apply()
                service<DeviceFlowLoginService>().signIn(null)
            }
        }
        val signOut = JButton("Sign out").apply {
            addActionListener {
                service<TokenStore>().signOut()
                refreshStatus()
            }
        }
        val pasteKey = JButton("Paste API key…").apply {
            addActionListener {
                val key = Messages.showPasswordDialog(
                    "Paste a scoped vmcp_ API key (admin-issued, shown once). " +
                        "Used as a headless fallback when not signed in; clear it by leaving this blank.",
                    "VegaDuta API Key"
                )
                if (key != null) {
                    service<TokenStore>().setApiKey(key)
                    refreshStatus()
                }
            }
        }
        envCombo.addActionListener { updateCustomFieldsEnabled() }

        val buttons = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0)).apply {
            add(signIn)
            add(signOut)
            add(pasteKey)
        }

        val agentKey = JButton("Set agent API key…").apply {
            addActionListener {
                val key = Messages.showPasswordDialog(
                    "Key for the OpenAI-compatible provider above. Leave blank to clear it - a local " +
                        "server needs no key. Stored in the OS keychain, never in settings.",
                    "VegaDuta Agent API Key"
                )
                // Cancel returns null and must not clear a stored key; an empty
                // string is the user deliberately clearing it.
                if (key != null) service<TokenStore>().setAgentApiKey(key)
            }
        }
        val detect = JButton("Detect local server").apply {
            addActionListener {
                isEnabled = false
                // Off the EDT: three probes with a 1.2s timeout each would
                // freeze the settings dialog if nothing is listening.
                ApplicationManager.getApplication().executeOnPooledThread {
                    val found = discoverLocalEndpoint()
                    SwingUtilities.invokeLater {
                        isEnabled = true
                        if (found == null) {
                            Messages.showInfoMessage(
                                "No OpenAI-compatible server answered on the well-known local ports.\n\n" +
                                    localEndpointHints(),
                                "No Local Server Found"
                            )
                        } else {
                            agentBaseField.text = found.baseUrl
                            agentModelField.text = found.models.first()
                        }
                    }
                }
            }
        }
        val agentButtons = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0)).apply {
            add(detect)
            add(agentKey)
        }

        runtimeRunButton.addActionListener {
            val model = CATALOG_MODELS.getOrNull(runtimeModelCombo.selectedIndex) ?: RECOMMENDED_MODEL
            service<BundledRuntimeService>().install(model.id)
        }
        runtimeStopButton.addActionListener {
            // stop() waits (briefly) for the process to exit - not on the EDT.
            ApplicationManager.getApplication().executeOnPooledThread { service<BundledRuntimeService>().stop() }
        }
        val runtimeRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0)).apply {
            add(runtimeModelCombo)
            add(runtimeRunButton)
            add(runtimeStopButton)
        }

        val built = FormBuilder.createFormBuilder()
            .addLabeledComponent("Environment:", envCombo)
            .addLabeledComponent("Custom API base:", customApiField)
            .addLabeledComponent("Custom auth base:", customAuthField)
            .addComponent(buttons)
            .addComponent(statusLabel)
            .addSeparator()
            .addComponent(privateModeCheck)
            .addComponent(
                JBLabel(
                    "<html>While on, no prompt, code, attachment or search query leaves this machine. " +
                        "Hosted chat, knowledge search, sandbox runs, workflow runs and a coding agent " +
                        "pointed at a non-local endpoint are blocked; your own local model server still " +
                        "works. Signing in and listing your agents and workflows still reach VegaDuta - " +
                        "they carry none of your content. The chat panel's toggle sets the same flag.</html>"
                )
            )
            .addSeparator()
            .addLabeledComponent("Bundled on-device model:", runtimeRow)
            .addComponent(runtimeStatusLabel)
            .addComponent(
                JBLabel(
                    "<html>Downloads the open-source llama.cpp server and the model you pick (checked " +
                        "against pinned checksums) into your home folder's .vegaduta directory, runs it " +
                        "on this computer only, and fills in the two fields below. It starts again when " +
                        "the IDE opens, until you press Stop.</html>"
                )
            )
            .addLabeledComponent("Local inference server:", localBaseField)
            .addLabeledComponent("Local model:", localModelField)
            .addComponent(localCompletionsCheck)
            .addComponent(
                JBLabel(
                    "<html>Completions are generated by your own server - the code around your caret " +
                        "goes to that URL and nowhere else. The chat tool window picks up a changed " +
                        "URL the next time it is opened.</html>"
                )
            )
            .addSeparator()
            .addComponent(JBLabel("<html><b>Coding agent</b> (Tools &gt; VegaDuta &gt; Start a Coding Task)</html>"))
            .addLabeledComponent("Agent endpoint:", agentBaseField)
            .addLabeledComponent("Agent model:", agentModelField)
            .addLabeledComponent("Max steps per task:", agentMaxStepsSpinner)
            .addComponent(agentButtons)
            .addComponent(agentAutoEditsCheck)
            .addComponent(agentAutoCommandsCheck)
            .addComponent(
                JBLabel(
                    "<html>The agent reads, searches, edits and runs commands in your open project. " +
                        "Edits and commands ask for approval unless you tick the boxes above - and a " +
                        "model that can run commands unattended runs them with your user's permissions. " +
                        "A short denylist refuses a few catastrophic commands outright; that is a " +
                        "backstop, not a sandbox.<br>" +
                        "Nothing in an agent run reaches VegaDuta: the only network call is to the " +
                        "endpoint above. Point it at a hosted provider and the files, search results " +
                        "and command output it reads go to <i>that</i> provider under your key.</html>"
                )
            )
            .addComponentFillVertically(JPanel(), 0)
            .panel
        panel = built
        service<TokenStore>().addAuthListener(authListener)
        val runtime = service<BundledRuntimeService>()
        runtime.addListener(runtimeListener)
        // Preselect the model last run, else the recommended one.
        val lastRun = catalogModel(VegadutaSettingsState.getInstance().bundledRuntimeModel) ?: RECOMMENDED_MODEL
        runtimeModelCombo.selectedIndex = CATALOG_MODELS.indexOf(lastRun)
        showRuntimeStatus(runtime.status())
        reset()
        return built
    }

    override fun isModified(): Boolean {
        val settings = VegadutaSettingsState.getInstance()
        return envCombo.selectedItem != settings.environment ||
            customApiField.text.trim() != settings.customApiBase ||
            customAuthField.text.trim() != settings.customAuthBase ||
            localBaseField.text.trim() != settings.localServerBaseUrl ||
            localModelField.text.trim() != settings.localServerModel ||
            localCompletionsCheck.isSelected != settings.localCompletionsEnabled ||
            agentBaseField.text.trim() != settings.agentBaseUrl ||
            agentModelField.text.trim() != settings.agentModel ||
            agentMaxStepsSpinner.number != settings.agentMaxSteps ||
            agentAutoEditsCheck.isSelected != settings.agentAutoApproveEdits ||
            agentAutoCommandsCheck.isSelected != settings.agentAutoApproveCommands ||
            privateModeCheck.isSelected != settings.privateMode
    }

    override fun apply() {
        val settings = VegadutaSettingsState.getInstance()
        settings.environment = envCombo.selectedItem as? String ?: VegadutaSettingsState.ENV_PRODUCTION
        settings.customApiBase = customApiField.text.trim()
        settings.customAuthBase = customAuthField.text.trim()
        settings.localServerBaseUrl = localBaseField.text.trim()
        settings.localServerModel = localModelField.text.trim()
        settings.localCompletionsEnabled = localCompletionsCheck.isSelected
        settings.agentBaseUrl = agentBaseField.text.trim()
        settings.agentModel = agentModelField.text.trim()
        settings.agentMaxSteps = agentMaxStepsSpinner.number
        settings.agentAutoApproveEdits = agentAutoEditsCheck.isSelected
        settings.agentAutoApproveCommands = agentAutoCommandsCheck.isSelected
        if (privateModeCheck.isSelected != settings.privateMode) {
            settings.privateMode = privateModeCheck.isSelected // notifies open chat panels
        }
        // Drop the memoized probe and cached completions: the point of editing
        // these fields is usually that the server moved or just came up.
        service<LocalCompletionEngine>().invalidate()
    }

    override fun reset() {
        val settings = VegadutaSettingsState.getInstance()
        envCombo.selectedItem = settings.environment
        customApiField.text = settings.customApiBase
        customAuthField.text = settings.customAuthBase
        localBaseField.text = settings.localServerBaseUrl
        localModelField.text = settings.localServerModel
        localCompletionsCheck.isSelected = settings.localCompletionsEnabled
        agentBaseField.text = settings.agentBaseUrl
        agentModelField.text = settings.agentModel
        agentMaxStepsSpinner.number = settings.agentMaxStepsBounded()
        agentAutoEditsCheck.isSelected = settings.agentAutoApproveEdits
        agentAutoCommandsCheck.isSelected = settings.agentAutoApproveCommands
        privateModeCheck.isSelected = settings.privateMode
        updateCustomFieldsEnabled()
        refreshStatus()
    }

    override fun disposeUIResources() {
        service<TokenStore>().removeAuthListener(authListener)
        service<BundledRuntimeService>().removeListener(runtimeListener)
        panel = null
    }

    private fun showRuntimeStatus(status: RuntimeStatusSnapshot) {
        val name = catalogModel(status.modelId)?.displayName ?: status.modelId
        val percent = status.progress?.let { " (${(it * 100).toInt()}%)" }.orEmpty()
        runtimeStatusLabel.text = when (status.state) {
            RuntimeState.ABSENT -> "Not downloaded. The recommended model is ${formatBytes(RECOMMENDED_MODEL.sizeBytes)}."
            RuntimeState.DOWNLOADING -> (status.detail ?: "Downloading...") + percent
            RuntimeState.STARTING -> status.detail ?: "Starting $name..."
            RuntimeState.RUNNING -> "Running: $name at ${status.baseUrl}"
            RuntimeState.STOPPED -> "Downloaded, not running."
            RuntimeState.ERROR -> "<html>" + (status.detail ?: "Something went wrong.")
                .replace("&", "&amp;").replace("<", "&lt;").replace("\n", "<br>") + "</html>"
        }
        val busy = status.state == RuntimeState.DOWNLOADING || status.state == RuntimeState.STARTING
        runtimeStopButton.isEnabled = busy || status.state == RuntimeState.RUNNING
        runtimeStopButton.text = if (status.state == RuntimeState.DOWNLOADING) "Cancel" else "Stop"
        runtimeRunButton.isEnabled = !busy
        runtimeModelCombo.isEnabled = !busy
        // Mark what is already on disk, so "Download & run" is honest about
        // what it will fetch.
        val installed = status.models.filter { it.installed }.map { it.id }.toSet()
        val selected = runtimeModelCombo.selectedIndex
        val labels = CATALOG_MODELS.map { m ->
            m.displayName + " - " + formatBytes(m.sizeBytes) +
                (if (m.recommended) ", recommended" else "") +
                (if (m.id in installed) ", downloaded" else "")
        }
        if ((0 until runtimeModelCombo.itemCount).map { runtimeModelCombo.getItemAt(it) } != labels) {
            runtimeModelCombo.removeAllItems()
            labels.forEach { runtimeModelCombo.addItem(it) }
            runtimeModelCombo.selectedIndex = selected.coerceIn(0, labels.size - 1)
        }
    }

    private fun updateCustomFieldsEnabled() {
        val custom = envCombo.selectedItem == VegadutaSettingsState.ENV_CUSTOM
        customApiField.isEnabled = custom
        customAuthField.isEnabled = custom
    }

    private fun refreshStatus() {
        val tokens = service<TokenStore>()
        val parts = mutableListOf<String>()
        parts += if (tokens.isSignedIn()) {
            "Signed in${tokens.usernameOrNull()?.let { " as $it" } ?: ""}"
        } else {
            "Signed out"
        }
        if (tokens.apiKey() != null) {
            parts += "API key set"
        }
        statusLabel.text = parts.joinToString(" · ")
    }
}
