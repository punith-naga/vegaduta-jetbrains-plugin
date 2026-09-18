// Plain-Swing fallback chat surface, used when JCEF is unsupported (headless
// JBR, disabled ide.browser.jcef.enabled) or the webview bundle wasn't built
// into resources. Drives the same ApiClient/streamChat as the JCEF path.

package ai.vegaduta.ide.toolwindow

import ai.vegaduta.ide.api.AgentSummary
import ai.vegaduta.ide.api.ApiClient
import ai.vegaduta.ide.auth.DeviceFlowLoginService
import ai.vegaduta.ide.auth.TokenStore
import ai.vegaduta.ide.context.IdeContextCollector
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.swing.BorderFactory
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

class SwingChatPanel(private val project: Project) : Disposable, ChatSurface {

    private val transcript = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        border = BorderFactory.createEmptyBorder(8, 8, 8, 8)
    }
    private val input = JBTextField()
    private val sendButton = JButton("Send")
    private val authButton = JButton("Sign in")
    private val agentModel = DefaultComboBoxModel<AgentSummary>()
    private val agentCombo = ComboBox(agentModel).apply {
        renderer = SimpleListCellRenderer.create("No agents") { it?.name }
    }
    private val statusLabel = JBLabel(" ")

    val component: JComponent

    private var sessionId: String? = null
    private val activeCancel = AtomicReference<AtomicBoolean?>(null)
    /** Context a prefill attached, appended to the next message sent. */
    private val pendingContext = AtomicReference<String?>(null)

    private val authListener = Runnable {
        ApplicationManager.getApplication().invokeLater {
            refreshAuthUi()
            reloadAgents()
        }
    }

    init {
        val top = JPanel(BorderLayout(8, 0)).apply {
            border = BorderFactory.createEmptyBorder(6, 8, 6, 8)
            add(agentCombo, BorderLayout.CENTER)
            add(authButton, BorderLayout.EAST)
        }
        val bottom = JPanel(BorderLayout(8, 0)).apply {
            border = BorderFactory.createEmptyBorder(6, 8, 8, 8)
            add(input, BorderLayout.CENTER)
            add(sendButton, BorderLayout.EAST)
        }
        component = JPanel(BorderLayout()).apply {
            add(top, BorderLayout.NORTH)
            add(JBScrollPane(transcript), BorderLayout.CENTER)
            add(JPanel(BorderLayout()).apply {
                add(statusLabel, BorderLayout.NORTH)
                add(bottom, BorderLayout.SOUTH)
            }, BorderLayout.SOUTH)
        }

        agentCombo.addActionListener { sessionId = null } // new agent, new conversation
        sendButton.addActionListener { onSendOrStop() }
        input.addActionListener { onSendOrStop() } // Enter in the field
        authButton.addActionListener {
            if (service<TokenStore>().isSignedIn()) {
                service<TokenStore>().signOut()
            } else {
                service<DeviceFlowLoginService>().signIn(project)
            }
        }

        service<TokenStore>().addAuthListener(authListener)
        refreshAuthUi()
        reloadAgents()
    }

    override fun dispose() {
        service<TokenStore>().removeAuthListener(authListener)
        activeCancel.get()?.set(true)
        if (!project.isDisposed) {
            project.service<ChatSurfaceRegistry>().clear(this)
        }
    }

    // Prefills the composer; multiline selections are sent verbatim even though
    // JBTextField renders them on one line - fine for a fallback surface.
    override fun sendSelection(text: String, languageId: String?, fileName: String?) {
        ApplicationManager.getApplication().invokeLater {
            input.text = text
            input.requestFocusInWindow()
        }
    }

    // The fallback surface has no attachment chips: the collected context is
    // held here, named in the status line, and appended to the next message.
    // It never auto-sends - the person reads the prompt and presses Enter.
    override fun prefill(text: String, context: List<String>, send: Boolean) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = if (context.isEmpty()) null else IdeContextCollector(project).collect(context)
            val attached = result?.items.orEmpty()
            pendingContext.set(
                attached.takeIf { it.isNotEmpty() }?.joinToString("\n\n") { item ->
                    "--- ${item.label}${if (item.truncated) " (truncated)" else ""} ---\n${item.text}"
                }
            )
            val notes = buildList {
                if (attached.isNotEmpty()) add("Attached: " + attached.joinToString(", ") { it.label })
                result?.missing?.forEach { add("Not attached (${it.kind}): ${it.reason}") }
            }
            ApplicationManager.getApplication().invokeLater {
                input.text = text
                statusLabel.text = if (notes.isEmpty()) " " else "  " + notes.joinToString(" | ")
                input.requestFocusInWindow()
            }
        }
    }

    private fun refreshAuthUi() {
        val tokens = service<TokenStore>()
        val usable = tokens.isSignedIn() || tokens.apiKey() != null
        authButton.text = if (tokens.isSignedIn()) "Sign out" else "Sign in"
        sendButton.isEnabled = usable
        input.isEnabled = usable
        statusLabel.text = if (usable) {
            tokens.usernameOrNull()?.let { "  Signed in as $it" } ?: " "
        } else {
            "  Sign in to chat with your agents."
        }
    }

    private fun reloadAgents() {
        val tokens = service<TokenStore>()
        if (!tokens.isSignedIn() && tokens.apiKey() == null) {
            agentModel.removeAllElements()
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val agents = runCatching { service<ApiClient>().listAgents() }.getOrElse { emptyList() }
            ApplicationManager.getApplication().invokeLater {
                val selected = (agentCombo.selectedItem as? AgentSummary)?.id
                agentModel.removeAllElements()
                for (agent in agents) {
                    agentModel.addElement(agent)
                }
                agents.firstOrNull { it.id == selected }?.let { agentCombo.selectedItem = it }
            }
        }
    }

    private fun onSendOrStop() {
        val streaming = activeCancel.get()
        if (streaming != null) {
            streaming.set(true)
            return
        }
        val agent = agentCombo.selectedItem as? AgentSummary
        if (agent == null) {
            appendOnEdt("\n[No agent selected - sign in and pick an agent.]\n")
            return
        }
        val typed = input.text.trim()
        if (typed.isEmpty()) return
        input.text = ""
        val attachment = pendingContext.getAndSet(null)
        val message = if (attachment != null) "$typed\n\n$attachment" else typed
        appendOnEdt("You: $typed" + (if (attachment != null) " [+ attached context]" else "") + "\n\n${agent.name}: ")

        val cancelled = AtomicBoolean(false)
        activeCancel.set(cancelled)
        sendButton.text = "Stop"
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                service<ApiClient>().streamChat(
                    agent.id, message, sessionId, cancelled,
                    onSessionId = { sessionId = it },
                    onChunk = { delta -> appendOnEdt(delta) }
                )
                appendOnEdt("\n\n")
            } catch (e: Exception) {
                appendOnEdt("\n[Error: ${e.message}]\n\n")
            } finally {
                activeCancel.set(null)
                ApplicationManager.getApplication().invokeLater { sendButton.text = "Send" }
            }
        }
    }

    private fun appendOnEdt(text: String) {
        ApplicationManager.getApplication().invokeLater {
            transcript.append(text)
            transcript.caretPosition = transcript.document.length
        }
    }
}
