// Settings | Tools | VegaDuta: environment picker (staging | production |
// custom bases) plus Sign in / Sign out / Paste API key. Auth actions apply
// immediately (they are not part of the modified/apply cycle - only the
// environment fields are).

package ai.vegaduta.ide.settings

import ai.vegaduta.ide.auth.DeviceFlowLoginService
import ai.vegaduta.ide.auth.TokenStore
import com.intellij.openapi.components.service
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.Messages
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

        val built = FormBuilder.createFormBuilder()
            .addLabeledComponent("Environment:", envCombo)
            .addLabeledComponent("Custom API base:", customApiField)
            .addLabeledComponent("Custom auth base:", customAuthField)
            .addComponent(buttons)
            .addComponent(statusLabel)
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
            customAuthField.text.trim() != settings.customAuthBase
    }

    override fun apply() {
        val settings = VegadutaSettingsState.getInstance()
        settings.environment = envCombo.selectedItem as? String ?: VegadutaSettingsState.ENV_PRODUCTION
        settings.customApiBase = customApiField.text.trim()
        settings.customAuthBase = customAuthField.text.trim()
    }

    override fun reset() {
        val settings = VegadutaSettingsState.getInstance()
        envCombo.selectedItem = settings.environment
        customApiField.text = settings.customApiBase
        customAuthField.text = settings.customAuthBase
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
