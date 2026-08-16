plugins {
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "ai.vegaduta"
version = "0.1.0"

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
    }
    // Wire DTOs + webview protocol JSON (mirrors clients/shared/src/api/types.ts).
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
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
