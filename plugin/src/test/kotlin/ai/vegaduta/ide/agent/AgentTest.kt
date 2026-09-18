// Mirrors clients/shared/test/agent.test.ts: covers the two pieces of the agent
// layer that carry real logic - tool-argument repair (small models emit broken
// JSON constantly) and the loop's stop conditions (the bits that decide whether
// a stuck model burns a budget or is caught). The model adapter's HTTP shaping
// is covered through a fake transport.
//
// Plain JUnit/kotlin.test: nothing here touches the IntelliJ platform, so these
// need no IDE fixture and run in milliseconds.

package ai.vegaduta.ide.agent

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val ECHO = ToolSpec(
    name = "echo",
    description = "echo",
    parameters = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") {}
    },
    mutating = false,
)

private fun args(vararg pairs: Pair<String, String>): JsonObject = buildJsonObject {
    pairs.forEach { (key, value) -> put(key, value) }
}

private fun toolCall(name: String, args: JsonObject = JsonObject(emptyMap())): ToolCall =
    ToolCall(id = "id-$name", name = name, args = args)

private class FakeExecutor(
    private val handler: (ToolCall) -> ToolOutcome = { ToolOutcome("ok") },
) : ToolExecutor {
    val calls = mutableListOf<ToolCall>()

    override fun specs(): List<ToolSpec> = listOf(ECHO)

    override fun execute(call: ToolCall, cancelled: AtomicBoolean): ToolOutcome {
        calls += call
        return handler(call)
    }
}

/** A model that replays a scripted sequence of results, one per chat() call. */
private class ScriptedModel(private val script: List<ModelResult>) : AgentModel {
    val seen = mutableListOf<List<AgentMessage>>()
    private var index = 0

    override val id: String = "scripted"

    override fun probe(): Boolean = true

    override fun chat(
        messages: List<AgentMessage>,
        tools: List<ToolSpec>,
        cancelled: AtomicBoolean,
    ): ModelResult {
        seen += messages.toList()
        return script.getOrElse(index++) { AgentFailure(AgentFailureReason.EMPTY_REPLY) }
    }
}

private val SEED = listOf(
    AgentMessage.System("sys"),
    AgentMessage.User("do the thing"),
)

class ParseToolArgumentsTest {

    @Test
    fun `accepts well-formed JSON objects`() {
        assertEquals(args("path" to "src/a.ts"), parseToolArguments("""{"path":"src/a.ts"}"""))
    }

    @Test
    fun `treats missing and empty arguments as no arguments`() {
        assertEquals(JsonObject(emptyMap()), parseToolArguments(null))
        assertEquals(JsonObject(emptyMap()), parseToolArguments("   "))
    }

    @Test
    fun `recovers an object wrapped in the model's prose`() {
        assertEquals(args("path" to "a.ts"), parseToolArguments("""Sure! {"path":"a.ts"} hope that helps"""))
    }

    @Test
    fun `returns null rather than guessing at unrepairable arguments`() {
        assertNull(parseToolArguments("path: a.ts"))
        assertNull(parseToolArguments("{path: 'a.ts'}"))
    }

    @Test
    fun `rejects a bare array - tool arguments are always an object`() {
        assertNull(parseToolArguments("[1,2,3]"))
    }
}

class LooksLikeNoToolSupportTest {

    @Test
    fun `matches the body, not the status`() {
        assertTrue(looksLikeNoToolSupport(400, "this model does not support tools"))
        assertTrue(looksLikeNoToolSupport(422, "Unrecognized request argument: tools"))
        // A 500 is a provider outage, not a capability statement.
        assertFalse(looksLikeNoToolSupport(500, "this model does not support tools"))
        assertFalse(looksLikeNoToolSupport(400, "context length exceeded"))
    }
}

class RunAgentLoopTest {

    @Test
    fun `finishes when the model stops asking for tools`() {
        val model = ScriptedModel(listOf(ModelReply("all done", emptyList(), "m")))
        val executor = FakeExecutor()

        val result = runAgentLoop(model, executor, SEED)

        val success = assertIs<AgentRunSuccess>(result)
        assertEquals("all done", success.answer)
        assertEquals(1, success.stepsUsed)
        assertEquals(0, executor.calls.size)
    }

    @Test
    fun `feeds each tool result back to the model before the next step`() {
        val model = ScriptedModel(
            listOf(
                ModelReply("", listOf(toolCall("echo", args("n" to "1"))), "m"),
                ModelReply("finished", emptyList(), "m"),
            )
        )
        val executor = FakeExecutor { ToolOutcome("tool said hi") }

        val result = runAgentLoop(model, executor, SEED)

        assertIs<AgentRunSuccess>(result)
        assertEquals(1, executor.calls.size)
        // The second request must carry the assistant's tool call AND its result,
        // in that order - providers reject a tool message with no matching call.
        val second = model.seen[1]
        assertIs<AgentMessage.Assistant>(second[second.size - 2])
        val toolMessage = assertIs<AgentMessage.Tool>(second[second.size - 1])
        assertEquals("id-echo", toolMessage.toolCallId)
        assertEquals("tool said hi", toolMessage.content)
    }

    @Test
    fun `answers a hallucinated tool name instead of ending the run`() {
        val model = ScriptedModel(
            listOf(
                ModelReply("", listOf(toolCall("not_a_tool")), "m"),
                ModelReply("recovered", emptyList(), "m"),
            )
        )
        val executor = FakeExecutor()

        val result = runAgentLoop(model, executor, SEED)

        assertIs<AgentRunSuccess>(result)
        assertEquals(0, executor.calls.size)
        val reply = assertIs<AgentMessage.Tool>(model.seen[1].last())
        assertEquals("id-not_a_tool", reply.toolCallId)
        assertTrue(reply.content.contains("no tool named"))
        assertTrue(reply.content.contains("echo"))
    }

    @Test
    fun `breaks a model stuck repeating one identical call`() {
        val repeat = ModelReply("", listOf(toolCall("echo", args("same" to "true"))), "m")
        val model = ScriptedModel(List(5) { repeat })
        val executor = FakeExecutor()

        runAgentLoop(model, executor, SEED, maxSteps = 5)

        // Executed on the first three identical calls, then refused - the model is
        // told to change approach rather than being allowed to spend the budget.
        assertEquals(3, executor.calls.size)
    }

    @Test
    fun `stops at the step budget rather than running forever`() {
        val forever = ModelReply("", listOf(toolCall("echo")), "m")
        val model = ScriptedModel(List(10) { forever })

        val result = runAgentLoop(model, FakeExecutor(), SEED, maxSteps = 2)

        val failure = assertIs<AgentFailure>(result)
        assertEquals(AgentFailureReason.STEP_BUDGET_EXCEEDED, failure.reason)
    }

    @Test
    fun `has a bounded default budget`() {
        assertTrue(DEFAULT_MAX_STEPS > 15)
        assertTrue(DEFAULT_MAX_STEPS <= 100)
    }

    @Test
    fun `propagates a model failure unchanged`() {
        val model = ScriptedModel(listOf(AgentFailure(AgentFailureReason.NO_TOOL_SUPPORT, "400")))

        val result = runAgentLoop(model, FakeExecutor(), SEED)

        val failure = assertIs<AgentFailure>(result)
        assertEquals(AgentFailureReason.NO_TOOL_SUPPORT, failure.reason)
        assertEquals("400", failure.detail)
    }

    @Test
    fun `stops when the caller cancels`() {
        val cancelled = AtomicBoolean(true)
        val model = ScriptedModel(listOf(ModelReply("x", emptyList(), "m")))

        val result = runAgentLoop(model, FakeExecutor(), SEED, cancelled = cancelled)

        val failure = assertIs<AgentFailure>(result)
        assertEquals(AgentFailureReason.ABORTED, failure.reason)
    }
}

class OpenAiCompatibleModelTest {

    /** Routes by URL suffix the way the TS suite's fake `fetch` does. */
    private fun transport(
        models: HttpReply = HttpReply(200, """{"data":[{"id":"m"}]}"""),
        completions: (HttpCall) -> HttpReply = { HttpReply(200, """{"choices":[{"message":{"content":"hi"}}]}""") },
    ): HttpTransport = HttpTransport { call ->
        if (call.url.endsWith("/v1/models")) models else completions(call)
    }

    @Test
    fun `adopts the server's first model when none is configured`() {
        val model = OpenAiCompatibleModel(
            OpenAiCompatibleOptions(
                transport = transport(models = HttpReply(200, """{"data":[{"id":"qwen2.5-coder:7b"}]}"""))
            )
        )

        assertTrue(model.probe())
        assertTrue(model.id.contains("qwen2.5-coder:7b"))
    }

    @Test
    fun `defaults to the user's own local inference server`() {
        // RULE 0 carve-out: a 127.0.0.1 default is only ever allowed for this -
        // the user's own inference server, never a platform URL or token issuer.
        assertEquals("http://127.0.0.1:11434", DEFAULT_LOCAL_BASE_URL)
        assertTrue(OpenAiCompatibleModel(OpenAiCompatibleOptions(model = "m")).id.startsWith(DEFAULT_LOCAL_BASE_URL))
    }

    @Test
    fun `maps tool calls off the wire and repairs their arguments`() {
        val body = """
            {"choices":[{"message":{"content":"","tool_calls":[
              {"id":"c1","function":{"name":"read_file","arguments":"here: {\"path\":\"a.ts\"}"}}
            ]}}]}
        """.trimIndent()
        val model = OpenAiCompatibleModel(OpenAiCompatibleOptions(transport = transport { HttpReply(200, body) }))

        val result = model.chat(listOf(AgentMessage.User("go")), listOf(ECHO))

        val reply = assertIs<ModelReply>(result)
        assertEquals(listOf(ToolCall("c1", "read_file", args("path" to "a.ts"))), reply.toolCalls)
    }

    @Test
    fun `sends the tools payload and the assistant's own tool call back`() {
        var sent: String? = null
        val model = OpenAiCompatibleModel(
            OpenAiCompatibleOptions(
                model = "m",
                transport = transport {
                    sent = it.body
                    HttpReply(200, """{"choices":[{"message":{"content":"done"}}]}""")
                },
            )
        )

        model.chat(
            listOf(
                AgentMessage.User("go"),
                AgentMessage.Assistant("", listOf(toolCall("echo", args("path" to "a.ts")))),
                AgentMessage.Tool("id-echo", "echo", "ok"),
            ),
            listOf(ECHO),
        )

        val payload = assertNotNull(sent)
        assertTrue(payload.contains("\"tool_choice\":\"auto\""))
        assertTrue(payload.contains("\"name\":\"echo\""))
        // Arguments go back as a JSON *string*, and an empty assistant turn as
        // null - providers reject an empty string on a tool-calling message.
        assertTrue(payload.contains("{\\\"path\\\":\\\"a.ts\\\"}"))
        assertTrue(payload.contains("\"role\":\"assistant\",\"content\":null"))
    }

    @Test
    fun `reports a provider that cannot do tool calling as such, not as a generic failure`() {
        val model = OpenAiCompatibleModel(
            OpenAiCompatibleOptions(transport = transport { HttpReply(400, "this model does not support tools") })
        )

        val failure = assertIs<AgentFailure>(model.chat(listOf(AgentMessage.User("go")), listOf(ECHO)))
        assertEquals(AgentFailureReason.NO_TOOL_SUPPORT, failure.reason)
    }

    @Test
    fun `never throws when the endpoint is unreachable`() {
        val dead = HttpTransport { throw IOException("ECONNREFUSED") }
        val model = OpenAiCompatibleModel(OpenAiCompatibleOptions(model = "m", transport = dead))

        assertFalse(model.probe())
        val failure = assertIs<AgentFailure>(model.chat(listOf(AgentMessage.User("go")), emptyList()))
        assertEquals(AgentFailureReason.MODEL_FAILED, failure.reason)
    }

    @Test
    fun `reports a refusal and an empty reply distinctly`() {
        val refused = OpenAiCompatibleModel(
            OpenAiCompatibleOptions(
                model = "m",
                transport = transport {
                    HttpReply(200, """{"choices":[{"finish_reason":"content_filter","message":{"content":""}}]}""")
                },
            )
        )
        assertEquals(
            AgentFailureReason.MODEL_REFUSED,
            assertIs<AgentFailure>(refused.chat(listOf(AgentMessage.User("go")), emptyList())).reason,
        )

        val empty = OpenAiCompatibleModel(
            OpenAiCompatibleOptions(
                model = "m",
                transport = transport { HttpReply(200, """{"choices":[{"message":{"content":"  "}}]}""") },
            )
        )
        assertEquals(
            AgentFailureReason.EMPTY_REPLY,
            assertIs<AgentFailure>(empty.chat(listOf(AgentMessage.User("go")), emptyList())).reason,
        )
    }
}

class CodingToolsTest {

    @Test
    fun `ships exactly the six canonical tools with the shared mutating flags`() {
        assertEquals(
            listOf(LIST_DIR, READ_FILE, SEARCH_TEXT, WRITE_FILE, EDIT_FILE, RUN_COMMAND),
            CODING_TOOL_SPECS.map { it.name },
        )
        assertEquals(
            setOf(WRITE_FILE, EDIT_FILE, RUN_COMMAND),
            CODING_TOOL_SPECS.filter { it.mutating }.map { it.name }.toSet(),
        )
    }

    @Test
    fun `every spec declares an object schema with its required arguments`() {
        for (spec in CODING_TOOL_SPECS) {
            assertEquals("object", (spec.parameters["type"] as? JsonPrimitive)?.content, spec.name)
            assertNotNull(spec.parameters["properties"], spec.name)
            assertNotNull(spec.parameters["required"], spec.name)
        }
    }

    @Test
    fun `the system prompt carries the workspace and any project conventions`() {
        val prompt = buildCodingSystemPrompt(
            SystemPromptContext(workspaceName = "my-repo", projectNotes = "use tabs", activeFile = "a.kt")
        )

        assertTrue(prompt.contains("Workspace: my-repo"))
        assertTrue(prompt.contains("The user currently has open: a.kt"))
        assertTrue(prompt.contains("use tabs"))
        // Omitted context must not leave a dangling label behind.
        val bare = buildCodingSystemPrompt(SystemPromptContext(workspaceName = "my-repo"))
        assertFalse(bare.contains("currently has open"))
        assertFalse(bare.contains("Project conventions"))
    }
}
