import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "ai.vegaduta"
version = "0.4.1"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.2")
        // Required for the :instrumentCode task (NotNull assertions etc.) -
        // without it, `./gradlew build`/`buildPlugin` fails with "No Java
        // Compiler dependency found".
        instrumentationTools()
        // The IntelliJ Plugin Verifier CLI itself. Configuring
        // intellijPlatform.pluginVerification (below) is NOT enough - without
        // this line :verifyPlugin fails with "No IntelliJ Plugin Verifier
        // executable found". Separate from the IDEs it verifies AGAINST.
        pluginVerifier()
    }
    // Wire DTOs + webview protocol JSON (mirrors clients/shared/src/api/types.ts).
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // src/test - plain JUnit 5 for the agent layer, which touches no platform
    // API and therefore needs no IDE test fixture. Test-classpath only: the
    // shipped plugin still carries no stdlib of its own (see gradle.properties).
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    // 2024.2+ platform requires JDK 21 for plugin compilation.
    jvmToolchain(21)
}

intellijPlatform {
    buildSearchableOptions = false
    pluginConfiguration {
        id = "ai.vegaduta.ide"
        name = "VegaDuta"
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null }
        }
    }

    // `./gradlew publishPlugin` uploads build/distributions/*.zip to the
    // JetBrains Marketplace. The token comes from the environment and is
    // never a Gradle property in a file: a permanent token in
    // gradle.properties is a token in git, and this directory is PUBLICLY
    // MIRRORED (see README) - it would be published on the next sync.
    //
    // Get one at https://plugins.jetbrains.com/author/me/tokens (the account
    // that owns plugin id 33539 / ai.vegaduta.ide), then:
    //   JETBRAINS_MARKETPLACE_TOKEN=perm:... ./gradlew publishPlugin
    //
    // channels: omitted, so this publishes to the DEFAULT (stable) channel.
    // Publishing to "eap" or another named channel would require users to add
    // a custom repository URL, which is not what a first listing wants.
    publishing {
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    }

    // `./gradlew verifyPlugin` runs JetBrains' own IntelliJ Plugin Verifier -
    // the same tool the Marketplace runs during review - against the IDEs this
    // plugin claims to support. Run it BEFORE submitting: a rejection costs a
    // review cycle, and the verifier finds the usual causes locally in
    // minutes (internal/experimental API use, missing dependencies,
    // since/until build problems).
    //
    // Pinned, NOT recommended(). `untilBuild` is deliberately open-ended
    // (null = "every future IDE"), and recommended() reads that range
    // literally: it tried to resolve ideaIC 2025.3, which is not a
    // downloadable artifact, and the whole task failed after a 900MB download
    // and 15 minutes. An explicit floor is the version this plugin actually
    // claims support for (sinceBuild 242 = 2024.2), which is the one that
    // matters for a first Marketplace review.
    //
    // Add newer lines here as they are released and verified, e.g.
    //   ide(IntelliJPlatformType.IntellijIdeaCommunity, "2025.1")
    // - each one is a real download the first time.
    pluginVerification {
        ides {
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2024.2.6")
        }
    }
}

// The chat webview is built by clients/shared (`npm run build:webview` writes
// ../shared/dist/webview) and copied into plugin resources before packaging.
// Tolerant when the bundle hasn't been built yet: with a missing source dir the
// Copy task is simply NO-SOURCE, and at runtime the tool window falls back to
// the Swing panel when resources/webview/index.html is absent.
val copyWebview by tasks.registering(Copy::class) {
    from(layout.projectDirectory.dir("../shared/dist/webview"))
    into(layout.projectDirectory.dir("src/main/resources/webview"))
}

tasks.named("processResources") {
    dependsOn(copyWebview)
}
