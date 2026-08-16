// Token storage rules (mirrors clients/shared/src/auth/oidc.ts):
//  - access token lives in memory only, with a 30s expiry safety margin;
//  - refresh token + optional pasted vmcp_ API key live in PasswordSafe under
//    the "VegaDuta IDE" credential service name;
//  - refresh via grant_type=refresh_token against the environment's Keycloak
//    (client agentic-ai-ide, realm agentic-ai).

package ai.vegaduta.ide.auth

import ai.vegaduta.ide.api.IDE_CLIENT_ID
import ai.vegaduta.ide.api.KEYCLOAK_REALM
import ai.vegaduta.ide.api.WireJson
import ai.vegaduta.ide.settings.VegadutaSettingsState
import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList

private const val SERVICE_NAME = "VegaDuta IDE"
private const val KEY_REFRESH_TOKEN = "refresh-token"
private const val KEY_API_KEY = "api-key"

@Service(Service.Level.APP)
class TokenStore {
    private val log = logger<TokenStore>()

    @Volatile private var accessToken: String? = null
    @Volatile private var expiresAtMs: Long = 0
    @Volatile private var username: String? = null

    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    /** Fired when the signed-in state flips (sign-in completed / signed out). */
    private val authListeners = CopyOnWriteArrayList<Runnable>()

    fun addAuthListener(listener: Runnable) {
        authListeners.add(listener)
    }

    fun removeAuthListener(listener: Runnable) {
        authListeners.remove(listener)
    }

    private fun attributes(key: String): CredentialAttributes =
        CredentialAttributes(generateServiceName(SERVICE_NAME, key))

    fun isSignedIn(): Boolean = accessToken != null || refreshToken() != null

    fun usernameOrNull(): String? = username

    /** "jwt" when interactively signed in, "apiKey" when only a pasted key exists. */
    fun authMode(): String? = when {
        isSignedIn() -> "jwt"
        apiKey() != null -> "apiKey"
        else -> null
    }

    /** Bearer for API calls: fresh access token, else refresh, else vmcp_ key. */
    fun bearerToken(): String? {
        accessToken?.let { if (System.currentTimeMillis() < expiresAtMs) return it }
        refreshBlocking()?.let { return it }
        return apiKey()
    }

    /** Blocking refresh-token exchange; returns the new access token or null.
     * Synchronized so parallel 401 handlers don't burn the rotating token. */
    @Synchronized
    fun refreshBlocking(): String? {
        // Another thread may have refreshed while we waited on the lock.
        accessToken?.let { if (System.currentTimeMillis() < expiresAtMs) return it }
        val refresh = refreshToken() ?: return null
        val response = try {
            http.send(
                HttpRequest.newBuilder(URI.create(tokenEndpoint()))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .timeout(Duration.ofSeconds(30))
                    .POST(
                        HttpRequest.BodyPublishers.ofString(
                            formEncode(
                                mapOf(
                                    "grant_type" to "refresh_token",
                                    "client_id" to IDE_CLIENT_ID,
                                    "refresh_token" to refresh,
                                )
                            )
                        )
                    )
                    .build(),
                HttpResponse.BodyHandlers.ofString()
            )
        } catch (e: Exception) {
            log.info("Token refresh failed (network): ${e.message}")
            return null
        }
        if (response.statusCode() !in 200..299) {
            val error = runCatching {
                WireJson.parseToJsonElement(response.body()).jsonObject["error"]?.jsonPrimitive?.contentOrNull
            }.getOrNull()
            // invalid_grant = refresh token expired/revoked; drop it so the UI shows signed-out.
            if (error == "invalid_grant") {
                signOut()
            }
            log.info("Token refresh rejected: $error")
            return null
        }
        return runCatching { storeTokenResponse(response.body()) }.getOrNull()
    }

    /** Parses a Keycloak token-endpoint response body and stores its contents.
     * Returns the access token. Used by both device flow and refresh. */
    fun storeTokenResponse(json: String): String {
        val obj = WireJson.parseToJsonElement(json).jsonObject
        val access = obj["access_token"]?.jsonPrimitive?.contentOrNull
            ?: throw IllegalStateException("Token response had no access_token")
        val wasSignedIn = isSignedIn()
        accessToken = access
        val expiresIn = obj["expires_in"]?.jsonPrimitive?.longOrNull ?: 60
        expiresAtMs = System.currentTimeMillis() + (expiresIn - 30).coerceAtLeast(0) * 1000
        username = claim(access, "preferred_username") ?: claim(access, "email")
        obj["refresh_token"]?.jsonPrimitive?.contentOrNull?.let { refresh ->
            PasswordSafe.instance.set(attributes(KEY_REFRESH_TOKEN), Credentials(KEY_REFRESH_TOKEN, refresh))
        }
        if (!wasSignedIn) {
            fireAuthChanged()
        }
        return access
    }

    fun signOut() {
        val wasSignedIn = isSignedIn()
        accessToken = null
        expiresAtMs = 0
        username = null
        PasswordSafe.instance.set(attributes(KEY_REFRESH_TOKEN), null)
        if (wasSignedIn) {
            fireAuthChanged()
        }
    }

    fun apiKey(): String? =
        PasswordSafe.instance.getPassword(attributes(KEY_API_KEY))?.takeIf { it.isNotBlank() }

    fun setApiKey(key: String?) {
        val value = key?.trim()?.takeIf { it.isNotBlank() }
        PasswordSafe.instance.set(attributes(KEY_API_KEY), value?.let { Credentials(KEY_API_KEY, it) })
        fireAuthChanged()
    }

    private fun fireAuthChanged() {
        for (listener in authListeners) {
            runCatching { listener.run() }
        }
    }

    private fun refreshToken(): String? =
        PasswordSafe.instance.getPassword(attributes(KEY_REFRESH_TOKEN))?.takeIf { it.isNotBlank() }

    private fun tokenEndpoint(): String =
        VegadutaSettingsState.getInstance().authBase().trimEnd('/') +
            "/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"

    /** Best-effort JWT payload claim read (display only - never for authz). */
    private fun claim(jwt: String, name: String): String? = runCatching {
        val payload = jwt.split(".").getOrNull(1) ?: return null
        val decoded = String(Base64.getUrlDecoder().decode(payload), Charsets.UTF_8)
        WireJson.parseToJsonElement(decoded).jsonObject[name]?.jsonPrimitive?.contentOrNull
    }.getOrNull()
}

internal fun formEncode(fields: Map<String, String>): String =
    fields.entries.joinToString("&") { (k, v) ->
        URLEncoder.encode(k, Charsets.UTF_8) + "=" + URLEncoder.encode(v, Charsets.UTF_8)
    }
