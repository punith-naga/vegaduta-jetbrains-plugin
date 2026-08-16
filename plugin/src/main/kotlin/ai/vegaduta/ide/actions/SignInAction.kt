package ai.vegaduta.ide.actions

import ai.vegaduta.ide.auth.DeviceFlowLoginService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware

class SignInAction : AnAction(), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        service<DeviceFlowLoginService>().signIn(e.project)
    }
}
