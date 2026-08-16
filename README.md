# VegaDuta for JetBrains IDEs

Source code for the **VegaDuta** IntelliJ-platform plugin published on JetBrains
Marketplace: <https://plugins.jetbrains.com/plugin/33539-vegaduta>

The plugin brings VegaDuta into the IDE: chat with your tenant's agents over
streaming SSE, run workflows with live progress, and send editor selections for
explanation or refactoring. Sign-in uses the OAuth 2.0 device grant (RFC 8628),
so it works over Remote Development and SSH without opening a local port.

Licensed under **Apache-2.0** — see [LICENSE](LICENSE).

## Layout

```
plugin/    The IntelliJ plugin itself (Kotlin, Gradle, intellij-platform 2.x).
           This is what is packaged and published to the Marketplace.
shared/    The shared TypeScript core the chat webview is built from — API
           client, SSE reader, device-flow auth, host<->webview protocol, and
           the on-device (WebLLM/Ollama) engine layer. `plugin/` consumes only
           the built bundle (shared/dist/webview), which is copied into plugin
           resources at package time.
```

`shared/` is extracted from the VegaDuta platform monorepo, where the same core
also backs the VS Code and Chrome clients. Only the JetBrains plugin and the
code it is built from are published here.

## Build from source

Requires JDK 21 (auto-provisioned by the foojay toolchain resolver if absent)
and Node 20+. The Gradle wrapper is committed, so no local Gradle install is
needed.

```bash
# 1. Build the chat webview bundle (shared/dist/webview)
cd shared
npm ci
npm run build:webview

# 2. Build the plugin — copyWebview picks the bundle up automatically
cd ../plugin
./gradlew buildPlugin
# -> plugin/build/distributions/vegaduta-jetbrains-<version>.zip
```

Step 1 is optional: with no webview bundle present the Gradle `copyWebview` task
is a no-op and the tool window falls back to a plain Swing chat panel. The
artifact published to the Marketplace is built with the webview included.

To run a sandbox IDE with the plugin loaded:

```bash
cd plugin
./gradlew runIde
```

The first build downloads the IntelliJ IDEA Community 2024.2 platform
distribution (~1 GB) and takes several minutes.

Tests for the shared core:

```bash
cd shared
npm test          # vitest — PKCE, SSE framing, host<->webview protocol
npm run typecheck
```

## Configuration

Settings > Tools > VegaDuta selects the environment: `production`
(api/auth.vegaduta.ai, the default), `staging` (api/auth.vegaduta.xyz), or
`custom` base URLs for self-hosted installs. There are no localhost defaults.

Self-hosted installs need the public Keycloak client `agentic-ai-ide` in the
`agentic-ai` realm with the device grant enabled. Being a public client it has
no secret; the plugin stores only the resulting refresh token, in the OS
keychain via IntelliJ's PasswordSafe (service name "VegaDuta IDE").

## Third-party

The chat webview bundle statically links [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm)
(Apache-2.0) for on-device inference. Remaining dependencies are the Kotlin
standard library and `kotlinx-serialization`, both Apache-2.0, and are resolved
at build time — see `plugin/build.gradle.kts` and `shared/package.json`.

## Contact

Issues and questions: <contact@vegaduta.ai> · <https://vegaduta.ai>
