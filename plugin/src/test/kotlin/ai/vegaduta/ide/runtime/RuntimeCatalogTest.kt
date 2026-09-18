package ai.vegaduta.ide.runtime

import java.nio.file.Paths
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RuntimeCatalogTest {

    @Test
    fun `picks the right archive for every supported os name and arch`() {
        val cases = mapOf(
            ("Windows 11" to "amd64") to "llama-b11037-bin-win-cpu-x64.zip",
            ("Windows 10" to "aarch64") to "llama-b11037-bin-win-cpu-arm64.zip",
            ("Mac OS X" to "aarch64") to "llama-b11037-bin-macos-arm64.tar.gz",
            ("Mac OS X" to "x86_64") to "llama-b11037-bin-macos-x64.tar.gz",
            ("Linux" to "amd64") to "llama-b11037-bin-ubuntu-x64.tar.gz",
            ("Linux" to "aarch64") to "llama-b11037-bin-ubuntu-arm64.tar.gz",
        )
        for ((platform, asset) in cases) {
            val archive = assertNotNull(runtimeArchiveFor(platform.first, platform.second), "$platform")
            assertEquals(asset, archive.assetName, "$platform")
        }
    }

    @Test
    fun `returns null for unsupported platforms`() {
        assertNull(runtimeArchiveFor("Windows 10", "x86"))
        assertNull(runtimeArchiveFor("Linux", "arm"))
        assertNull(runtimeArchiveFor("Linux", "ppc64le"))
        assertNull(runtimeArchiveFor("FreeBSD", "amd64"))
        assertNull(runtimeArchiveFor("SunOS", "sparcv9"))
        assertNull(runtimeArchiveFor(null, "amd64"))
        assertNull(runtimeArchiveFor("Linux", null))
    }

    @Test
    fun `every pin is well formed and every url points at the pinned release`() {
        assertEquals(6, RUNTIME_ARCHIVES.size)
        assertEquals(RUNTIME_ARCHIVES.size, RUNTIME_ARCHIVES.map { it.platform }.toSet().size)
        for (a in RUNTIME_ARCHIVES) {
            assertTrue(Regex("^[0-9a-f]{64}$").matches(a.sha256), a.assetName)
            assertTrue(a.sizeBytes > 1_000_000, a.assetName)
            assertEquals("https://github.com/ggml-org/llama.cpp/releases/download/b11037/${a.assetName}", a.url)
            assertEquals(a.platform.os == RuntimeOs.WINDOWS, a.isZip, a.assetName)
        }
        for (m in CATALOG_MODELS) {
            assertTrue(Regex("^[0-9a-f]{64}$").matches(m.sha256), m.id)
            assertTrue(m.url.startsWith("https://huggingface.co/Qwen/"), m.url)
            assertTrue(m.url.endsWith("/resolve/main/${m.fileName}"), m.url)
        }
        assertEquals("qwen2.5-coder-1.5b", RECOMMENDED_MODEL.id)
        assertEquals(1, CATALOG_MODELS.count { it.recommended })
        assertNull(catalogModel("nope"))
    }

    @Test
    fun `storage layout is the one shared with the Eclipse plugin`() {
        val home = vegadutaHome("/home/someone")
        assertEquals(Paths.get("/home/someone", ".vegaduta"), home)
        val platform = RuntimePlatform(RuntimeOs.LINUX, RuntimeArch.ARM64)
        assertEquals(home.resolve("runtime").resolve("b11037-linux-arm64"), runtimeDir(platform, home))
        assertEquals(
            home.resolve("models").resolve("qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"),
            modelFile(RECOMMENDED_MODEL, home),
        )
    }
}
