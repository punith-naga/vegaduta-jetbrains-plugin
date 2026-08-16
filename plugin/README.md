# VegaDuta JetBrains Plugin

IntelliJ-platform plugin (IDEA, PyCharm, WebStorm, … — `sinceBuild 242` /
2024.2+) that brings VegaDuta into the IDE: chat with tenant agents
(streaming SSE), run workflows with progress, and send editor selections for
explain/refactor. Kotlin, `org.jetbrains.intellij.platform` Gradle plugin 2.x.

## Layout

```
build.gradle.kts          intellij-platform 2.x, kotlinx.serialization, copyWebview task
src/main/resources/META-INF/plugin.xml
src/main/kotlin/ai/vegaduta/ide/
  api/        Models.kt (wire DTOs), ApiClient.kt (java.net.http + SSE reader)
  auth/       DeviceFlowLoginService.kt (RFC 8628), TokenStore.kt (PasswordSafe)
  settings/   VegadutaSettingsState.kt, VegadutaConfigurable.kt
  toolwindow/ ChatToolWindowFactory.kt, JcefBridge.kt, SwingChatPanel.kt
  actions/    SignInAction, Explain/RefactorSelection, RunWorkflowAction
```

## Build & run

The Gradle wrapper (including `gradle/wrapper/gradle-wrapper.jar`) is
committed, so no local Gradle install is required. JDK 21 is auto-provisioned
via the foojay toolchain resolver if it's not already on the machine:

```bash
cd plugin
./gradlew runIde                       # launches a sandbox IDE with the plugin
./gradlew buildPlugin                  # -> build/distributions/vegaduta-jetbrains-0.1.0.zip
```

First run downloads the IntelliJ IDEA Community 2024.2 platform distribution
(~1GB) - expect several minutes on the first build.

### Chat webview (optional but recommended)

The tool window prefers the shared chat UI (same bundle as VS Code/Chrome),
rendered in JCEF. Build it first so the `copyWebview` Gradle task can pick it
up (the task is a no-op when the bundle is missing, and the tool window then
falls back to a plain Swing panel):

```bash
cd ../shared
npm install
npm run build:webview     # writes dist/webview/
cd ../plugin
./gradlew runIde          # copyWebview copies dist/webview -> src/main/resources/webview
```

`src/main/resources/webview/` is a build-time copy and is gitignored.

## Sign in

Primary flow is the OAuth **device grant** (works over Remote-SSH, no ports):

1. Tools > VegaDuta > Sign In… (or the Sign in button in the tool window /
   Settings > Tools > VegaDuta).
2. The system browser opens Keycloak's device page with the code pre-filled;
   approve there.
3. The IDE polls in the background and stores the refresh token in the OS
   keychain via PasswordSafe (service name "VegaDuta IDE"). Scope includes
   `offline_access`, so the session survives ~30 days without re-login.

Headless fallback: Settings > Tools > VegaDuta > "Paste API key…" accepts an
admin-issued `vmcp_` scoped key. In that mode calls are transparently routed
to the blocking `/api/dev/v1` surface (no streaming — chat replies arrive as
one message; listing/run-status need the B2 backend endpoints).

## Environments

Settings > Tools > VegaDuta: `production` (api/auth.vegaduta.ai, default),
`staging` (api/auth.vegaduta.xyz), or `custom` base URLs for self-hosted
installs. There are no localhost defaults anywhere.

The Keycloak realm (`agentic-ai`) must contain the public client
`agentic-ai-ide` with the device grant enabled. Being a public client it has no
secret; on an already-deployed realm it is a one-time `kcadm` step.

## Local inference note

JetBrains v1 is hosted-only: JCEF has no WebGPU today, so the shared webview
auto-detects and hides local (WebLLM) mode; the host passes
`hostLocalEngine: false` and just mirrors `engine.status` into a label. If
JCEF ever gains WebGPU it lights up without plugin changes. The Ollama/
OpenAI-compatible local backend is planned via the shared `LocalEngine`
registry (M2) and is not wired here yet.

## Smoke test

`./gradlew runIde` → sign in against staging → send a chat message and watch
word spacing in the streamed reply (the SSE reader strips exactly 5 chars of
`data:` — a 6-char strip drops lone-space chunks) → run a workflow from
Tools > VegaDuta → select code in an editor → right-click > VegaDuta >
Explain Selection. To force-test the Swing fallback, add
`-Dide.browser.jcef.enabled=false` to the sandbox VM options or build without
the webview bundle.
