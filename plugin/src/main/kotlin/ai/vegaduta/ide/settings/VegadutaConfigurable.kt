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
        panel = null
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
