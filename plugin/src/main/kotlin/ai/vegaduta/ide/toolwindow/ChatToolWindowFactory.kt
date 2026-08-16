// VegaDuta tool window (anchored right, see plugin.xml). Prefers the shared
// JCEF chat webview (same bundle as VS Code / Chrome); falls back to a plain
// Swing panel when JCEF is unsupported or the webview bundle wasn't built
// into resources (copyWebview task in build.gradle.kts).

package ai.vegaduta.ide.toolwindow

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp

const val TOOL_WINDOW_ID = "VegaDuta"

/** What editor actions need from whichever chat surface is active. */
interface ChatSurface {
    fun sendSelection(text: String, languageId: String?, fileName: String?)
}

/** Lets actions reach the active surface without holding UI references themselves. */
@Service(Service.Level.PROJECT)
class ChatSurfaceRegistry(@Suppress("unused") private val project: Project) {
    @Volatile var active: ChatSurface? = null

    fun clear(surface: ChatSurface) {
        if (active === surface) {
            active = null
        }
    }
}

class ChatToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val registry = project.service<ChatSurfaceRegistry>()
        val factory = ContentFactory.getInstance()
        if (JBCefApp.isSupported() && JcefBridge.isWebviewBundleAvailable()) {
            val bridge = JcefBridge(project)
            registry.active = bridge
            val content = factory.createContent(bridge.component, "", false)
            content.setDisposer(bridge)
            toolWindow.contentManager.addContent(content)
        } else {
            val panel = SwingChatPanel(project)
            registry.active = panel
            val content = factory.createContent(panel.component, "", false)
            content.setDisposer(panel)
            toolWindow.contentManager.addContent(content)
        }
    }
}
