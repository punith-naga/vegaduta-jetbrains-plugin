// Restart the bundled on-device model when the IDE opens, so on-device AI
// "just works" after the first Download & run. Runs once per IDE session (the
// service ignores later projects), only for a model the person started last
// time and has not stopped since, and only when every file is already on
// disk - it never downloads. The start itself is a background task; this
// activity returns at once and never touches the EDT.

package ai.vegaduta.ide.runtime

import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

class BundledRuntimeStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        service<BundledRuntimeService>().autoStartIfInstalled()
    }
}
