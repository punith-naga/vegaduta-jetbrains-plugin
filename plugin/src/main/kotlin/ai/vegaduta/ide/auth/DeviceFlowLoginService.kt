// OAuth 2.0 Device Authorization Grant (RFC 8628) against Keycloak - the
// primary IDE sign-in (no redirect URI, so it works under Remote-SSH and
// needs no loopback port). Twin of clients/shared/src/auth/deviceFlow.ts:
//   1. POST /realms/agentic-ai/protocol/openid-connect/auth/device
//      with client_id=agentic-ai-ide & scope=openid offline_access
//      (offline_access: realm SSO idle is 4h; offline tokens idle out at 30d)
//   2. BrowserUtil.browse(verification_uri_complete)
//   3. poll the token endpoint honoring authorization_pending / slow_down.

package ai.vegaduta.ide.auth

import ai.vegaduta.ide.api.ApiException
import ai.vegaduta.ide.api.IDE_CLIENT_ID
import ai.vegaduta.ide.api.KEYCLOAK_REALM
import ai.vegaduta.ide.api.WireJson
import ai.vegaduta.ide.settings.VegadutaSettingsState
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

@Service(Service.Level.APP)
class DeviceFlowLoginService {
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    /** Starts the device flow in a cancellable background task. */
    fun signIn(project: Project?, onSuccess: Runnable? = null) {
        object : Task.Backgroundable(project, "Signing in to VegaDuta", true) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    doSignIn(indicator)
                    val user = service<TokenStore>().usernameOrNull()
                    notify(
                        project,
                        "Signed in to VegaDuta${if (user != null) " as $user" else ""}.",
                        NotificationType.INFORMATION
                    )
                    onSuccess?.run()
                } catch (e: ProcessCanceledException) {
                    throw e
                } catch (e: Exception) {
                    notify(project, "VegaDuta sign-in failed: ${e.message}", NotificationType.ERROR)
                }
            }
        }.queue()
    }

    private fun doSignIn(indicator: ProgressIndicator) {
        val authBase = VegadutaSettingsState.getInstance().authBase().trimEnd('/')
        val base = "$authBase/realms/$KEYCLOAK_REALM/protocol/openid-connect"

        indicator.text = "Requesting device code…"
        val start = postForm(
            "$base/auth/device",
            mapOf("client_id" to IDE_CLIENT_ID, "scope" to "openid offline_access")
        )
        val startBody = parse(start.body())
        val deviceCode = startBody.str("device_code")
        val userCode = startBody.str("user_code")
        if (start.statusCode() !in 200..299 || deviceCode == null || userCode == null) {
            throw ApiException(
                start.statusCode(),
                startBody.str("error_description")
                    ?: "Could not start device sign-in. Check that the agentic-ai-ide client exists on this Keycloak (docs/IDE-PLUGIN-PLATFORM-CONTRACT-2026-08-08.md)."
            )
        }
        val verificationUri = startBody.str("verification_uri_complete")
            ?: startBody.str("verification_uri")
            ?: throw ApiException(0, "Device response had no verification URI.")
        var intervalMs = (startBody.long("interval") ?: 5) * 1000
        val expiresAt = System.currentTimeMillis() + (startBody.long("expires_in") ?: 600) * 1000

        BrowserUtil.browse(verificationUri)
        indicator.text = "Waiting for browser approval (code $userCode)…"

        while (true) {
            indicator.checkCanceled()
            if (System.currentTimeMillis() > expiresAt) {
                throw ApiException(0, "The sign-in code expired. Please start again.")
            }
            Thread.sleep(intervalMs)
            indicator.checkCanceled()

            val poll = postForm(
                "$base/token",
                mapOf(
                    "grant_type" to "urn:ietf:params:oauth:grant-type:device_code",
                    "client_id" to IDE_CLIENT_ID,
                    "device_code" to deviceCode,
                )
            )
            if (poll.statusCode() in 200..299) {
                service<TokenStore>().storeTokenResponse(poll.body())
                return
            }
            val body = parse(poll.body())
            when (body.str("error")) {
                "authorization_pending" -> continue
                "slow_down" -> intervalMs += 5000 // RFC 8628 §3.5
                "expired_token" -> throw ApiException(0, "The sign-in code expired. Please start again.")
                "access_denied" -> throw ApiException(0, "Sign-in was denied in the browser.")
                else -> throw ApiException(
                    poll.statusCode(),
                    body.str("error_description") ?: body.str("error") ?: "Token request failed (${poll.statusCode()})"
                )
            }
        }
    }

    private fun postForm(url: String, fields: Map<String, String>): HttpResponse<String> =
        http.send(
            HttpRequest.newBuilder(URI.create(url))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .timeout(Duration.ofSeconds(30))
                .POST(HttpRequest.BodyPublishers.ofString(formEncode(fields)))
                .build(),
            HttpResponse.BodyHandlers.ofString()
        )

    private fun parse(body: String?): JsonObject =
        runCatching { WireJson.parseToJsonElement(body ?: "{}").jsonObject }
            .getOrDefault(JsonObject(emptyMap()))

    private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.long(key: String): Long? = this[key]?.jsonPrimitive?.longOrNull

    private fun notify(project: Project?, message: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("VegaDuta")
            .createNotification(message, type)
            .notify(project)
    }
}
