// Persisted plugin settings. RULE 0 (CLAUDE.md): never localhost defaults -
// the two real deployments are staging (.xyz) and production (.ai); `custom`
// exists for self-hosted installs and is entered explicitly by the user.
// Mirrors ENVIRONMENTS in clients/shared/src/api/types.ts.

package ai.vegaduta.ide.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

@Service(Service.Level.APP)
@State(name = "VegadutaSettings", storages = [Storage("vegaduta-ide.xml")])
class VegadutaSettingsState : PersistentStateComponent<VegadutaSettingsState.State> {

    class State {
        var environment: String = ENV_PRODUCTION
        var customApiBase: String = ""
        var customAuthBase: String = ""
    }

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    var environment: String
        get() = state.environment
        set(value) {
            state.environment = value
        }

    var customApiBase: String
        get() = state.customApiBase
        set(value) {
            state.customApiBase = value
        }

    var customAuthBase: String
        get() = state.customAuthBase
        set(value) {
            state.customAuthBase = value
        }

    fun apiBase(): String = when (state.environment) {
        ENV_PRODUCTION -> "https://api.vegaduta.ai"
        ENV_CUSTOM -> state.customApiBase.trim().ifBlank { "https://api.vegaduta.xyz" }
        else -> "https://api.vegaduta.xyz"
    }

    fun authBase(): String = when (state.environment) {
        ENV_PRODUCTION -> "https://auth.vegaduta.ai"
        ENV_CUSTOM -> state.customAuthBase.trim().ifBlank { "https://auth.vegaduta.xyz" }
        else -> "https://auth.vegaduta.xyz"
    }

    companion object {
        const val ENV_STAGING = "staging"
        const val ENV_PRODUCTION = "production"
        const val ENV_CUSTOM = "custom"

        fun getInstance(): VegadutaSettingsState = service()
    }
}
