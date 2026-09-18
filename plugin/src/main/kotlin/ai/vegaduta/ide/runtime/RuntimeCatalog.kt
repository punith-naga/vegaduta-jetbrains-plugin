// The pinned catalog for the bundled on-device runtime: which llama.cpp build
// and which GGUF models the plugin may download, with each file's exact size
// and SHA-256. Nothing is downloaded that is not listed here, and nothing
// listed here is used until its hash matches.
//
// Pinned to ONE llama.cpp release on purpose: the server's flags and its
// /health contract are what BundledRuntimeService relies on, and a "latest"
// download would change them under us. To move to a newer build, update
// LLAMA_CPP_BUILD and every row in RUNTIME_ARCHIVES together (sizes and
// hashes from the release page's asset digests) - the storage folder name
// includes the build, so an old extraction is simply left unused.
//
// The CPU builds are chosen because they run everywhere without GPU drivers.
// The macOS builds include Metal, so Apple Silicon still gets its GPU.
//
// The storage layout under ~/.vegaduta is SHARED with the Eclipse plugin (see
// runtimeDir/modelFile below): either plugin reuses the other's downloads, so
// the layout must not change on one side only.
//
// Pure: no IntelliJ API, so the whole file is unit-testable.

package ai.vegaduta.ide.runtime

import java.nio.file.Path
import java.nio.file.Paths

/** The llama.cpp release every archive below comes from. */
const val LLAMA_CPP_BUILD = "b11037"

private const val LLAMA_CPP_DOWNLOAD_BASE =
    "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_CPP_BUILD/"

enum class RuntimeOs(val wire: String) { WINDOWS("windows"), MACOS("macos"), LINUX("linux") }

enum class RuntimeArch(val wire: String) { X64("x64"), ARM64("arm64") }

data class RuntimePlatform(val os: RuntimeOs, val arch: RuntimeArch) {
    /** e.g. "windows-x64" - the suffix of the runtime folder name. */
    val id: String get() = "${os.wire}-${arch.wire}"
}

/** One llama.cpp release archive. */
data class RuntimeArchive(
    val platform: RuntimePlatform,
    val assetName: String,
    val sizeBytes: Long,
    val sha256: String,
) {
    val url: String get() = LLAMA_CPP_DOWNLOAD_BASE + assetName
    val isZip: Boolean get() = assetName.endsWith(".zip")
}

/** One GGUF model. [id] is also the name llama-server serves it under
 * (--alias), so it is what /v1/models lists and what the chat asks for. */
data class CatalogModel(
    val id: String,
    val displayName: String,
    val repo: String,
    val fileName: String,
    val sizeBytes: Long,
    val sha256: String,
    val recommended: Boolean,
) {
    val url: String get() = "https://huggingface.co/$repo/resolve/main/$fileName"
}

val RUNTIME_ARCHIVES: List<RuntimeArchive> = listOf(
    RuntimeArchive(
        RuntimePlatform(RuntimeOs.WINDOWS, RuntimeArch.X64),
        "llama-$LLAMA_CPP_BUILD-bin-win-cpu-x64.zip", 18439506L,
        "cfa7eb5531fca78ca36dd4dd2555cc1deee0a062c404ab96de1b3fbe5fa313ae",
    ),
    RuntimeArchive(
        RuntimePlatform(RuntimeOs.WINDOWS, RuntimeArch.ARM64),
        "llama-$LLAMA_CPP_BUILD-bin-win-cpu-arm64.zip", 12002382L,
        "0c427a86f733ab9b1d0d40719d9f80dcdb45260f9aaf1062deca9a6d6029beda",
    ),
    RuntimeArchive(
        RuntimePlatform(RuntimeOs.MACOS, RuntimeArch.ARM64),
        "llama-$LLAMA_CPP_BUILD-bin-macos-arm64.tar.gz", 11156604L,
        "3573814427ef2df999adf74b43d55c6045bfb560b971305f3dffba36cd5de6b3",
    ),
    RuntimeArchive(
        RuntimePlatform(RuntimeOs.MACOS, RuntimeArch.X64),
        "llama-$LLAMA_CPP_BUILD-bin-macos-x64.tar.gz", 11205280L,
        "7a4e253b95d028edfdf0d2e22479aedd62d1149a60052bf004dc881420bd2546",
    ),
    RuntimeArchive(
        RuntimePlatform(RuntimeOs.LINUX, RuntimeArch.X64),
        "llama-$LLAMA_CPP_BUILD-bin-ubuntu-x64.tar.gz", 16856513L,
        "bb75ea4f1145899423a700871d608c81b9d93c13cfc306340e08437f3c2f9aa5",
    ),
    RuntimeArchive(
        RuntimePlatform(RuntimeOs.LINUX, RuntimeArch.ARM64),
        "llama-$LLAMA_CPP_BUILD-bin-ubuntu-arm64.tar.gz", 13481275L,
        "5edc41a4f1796f9e0193d904daf21024f59d89555bd063d244140ddd03d899e1",
    ),
)

val CATALOG_MODELS: List<CatalogModel> = listOf(
    CatalogModel(
        id = "qwen2.5-coder-1.5b",
        displayName = "Qwen2.5 Coder 1.5B, fast",
        repo = "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
        fileName = "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        sizeBytes = 1117320768L,
        sha256 = "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046",
        recommended = true,
    ),
    CatalogModel(
        id = "qwen2.5-coder-3b",
        displayName = "Qwen2.5 Coder 3B, balanced",
        repo = "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF",
        fileName = "qwen2.5-coder-3b-instruct-q4_k_m.gguf",
        sizeBytes = 2104932800L,
        sha256 = "724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7",
        recommended = false,
    ),
    CatalogModel(
        id = "qwen2.5-coder-7b",
        displayName = "Qwen2.5 Coder 7B, best quality (16 GB RAM)",
        repo = "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
        fileName = "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        sizeBytes = 4683073536L,
        sha256 = "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c",
        recommended = false,
    ),
)

val RECOMMENDED_MODEL: CatalogModel = CATALOG_MODELS.first { it.recommended }

fun catalogModel(id: String?): CatalogModel? = CATALOG_MODELS.firstOrNull { it.id == id }

/**
 * The platform for a JVM's `os.name` / `os.arch`, or null when llama.cpp
 * publishes no CPU build for it (32-bit, FreeBSD, ...). Never throws.
 */
fun detectPlatform(osName: String?, osArch: String?): RuntimePlatform? {
    val name = osName?.lowercase()?.trim() ?: return null
    val arch = osArch?.lowercase()?.trim() ?: return null
    val os = when {
        name.startsWith("windows") -> RuntimeOs.WINDOWS
        name.startsWith("mac") || name.startsWith("darwin") -> RuntimeOs.MACOS
        name.startsWith("linux") -> RuntimeOs.LINUX
        else -> return null
    }
    val cpu = when (arch) {
        "amd64", "x86_64", "x64", "x86-64" -> RuntimeArch.X64
        "aarch64", "arm64" -> RuntimeArch.ARM64
        else -> return null
    }
    return RuntimePlatform(os, cpu)
}

/** The archive to download on this os.name / os.arch, or null if unsupported. */
fun runtimeArchiveFor(osName: String?, osArch: String?): RuntimeArchive? {
    val platform = detectPlatform(osName, osArch) ?: return null
    return RUNTIME_ARCHIVES.firstOrNull { it.platform == platform }
}

/** The running JVM's archive, or null if unsupported. */
fun currentRuntimeArchive(): RuntimeArchive? =
    runtimeArchiveFor(System.getProperty("os.name"), System.getProperty("os.arch"))

/** ~/.vegaduta - shared with the Eclipse plugin. */
fun vegadutaHome(userHome: String = System.getProperty("user.home")): Path = Paths.get(userHome, ".vegaduta")

/** ~/.vegaduta/runtime/b11037-<os>-<arch>/ - the extracted llama.cpp build. */
fun runtimeDir(platform: RuntimePlatform, home: Path = vegadutaHome()): Path =
    home.resolve("runtime").resolve("$LLAMA_CPP_BUILD-${platform.id}")

/** ~/.vegaduta/models/<gguf file name>. */
fun modelFile(model: CatalogModel, home: Path = vegadutaHome()): Path =
    home.resolve("models").resolve(model.fileName)
