// Private Mode: the one rule every VegaDuta client enforces the same way.
//
// While Private Mode is on, NO prompt, code, attachment, page text or search
// query leaves the machine. Allowed: calls to the user's own local model
// server, and (on hosts that have it) on-device WebLLM inference plus
// fetching the public model manifest / weights on an explicit click - none of
// which carries the user's content. Blocked: hosted chat, hosted completions,
// hosted commands, knowledge search, the code sandbox (sdlc.run is hosted),
// workflow runs and code validation.
//
// It is NOT "nothing touches the network": signing in, listing agents and
// workflows, and polling a workflow run that was already started carry none of
// the user's content and still go to the platform.
//
// This file is the pure policy. Enforcement points:
//  - ApiClient: every hosted method that carries user content calls
//    requireHostedAllowed() first, so the JCEF bridge, the Swing fallback
//    panel and the Run Workflow action are all covered by one check;
//  - JcefBridge: answers early with a typed reason so the chat panel can say
//    why, rather than surfacing a thrown exception;
//  - StartCodingTaskAction: the coding agent only talks to a loopback model
//    server while Private Mode is on (a provider origin is not "local").
//
// JetBrains has no hosted completions (completions come from the user's own
// server only - ai.vegaduta.ide.completions) and no hosted code validation
// call, so there is nothing further to gate for those two.

package ai.vegaduta.ide.privacy

import ai.vegaduta.ide.api.ApiException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

/** A platform call that would carry the user's content off the machine. */
enum class HostedOperation(val label: String) {
    CHAT("hosted chat"),
    WORKFLOW_RUN("workflow runs"),
    SANDBOX_RUN("the code sandbox"),
    KNOWLEDGE_SEARCH("knowledge search"),
    CODE_VALIDATION("hosted code validation"),
    REMOTE_AGENT_MODEL("a coding-agent model that is not on this machine"),
}

/** Thrown by ApiClient when Private Mode blocks a hosted call. Status 0 - no
 * request was made. */
class PrivateModeBlockedException(val operation: HostedOperation, message: String) : ApiException(0, message)

object PrivateModePolicy {
    /** The status line under the chat tool window while Private Mode is on
     * (short - the tool window is narrow); [STATUS_ON_DETAIL] is its tooltip. */
    const val STATUS_ON = "Private Mode: on - nothing you type or attach leaves this machine"

    const val STATUS_ON_DETAIL =
        "Hosted chat, knowledge search, sandbox runs and workflow runs are blocked. Prompts go only to " +
            "your own local model server. Signing in and listing agents and workflows still reach VegaDuta; " +
            "they carry none of your content."

    /** Why [operation] is refused, or null when it may run. */
    fun blockReason(privateMode: Boolean, operation: HostedOperation): String? {
        if (!privateMode) return null
        return "Private Mode is on, so ${operation.label} is blocked: no prompt, code, attachment or search " +
            "query leaves this machine except to your own local model server. Turn Private Mode off to use it."
    }

    /** Throws [PrivateModeBlockedException] when [operation] is refused. */
    fun check(privateMode: Boolean, operation: HostedOperation) {
        val reason = blockReason(privateMode, operation) ?: return
        throw PrivateModeBlockedException(operation, reason)
    }

    /** May the coding agent use [baseUrl] while Private Mode is [privateMode]?
     * null (auto-discovery) only ever probes 127.0.0.1, so it is allowed. */
    fun agentEndpointAllowed(privateMode: Boolean, baseUrl: String?): Boolean =
        !privateMode || baseUrl == null || isLoopbackUrl(baseUrl)
}

/** True for http(s) URLs whose host is this machine: "localhost", 127.0.0.0/8
 * or ::1. Decided from the literal only - no DNS lookup, so a name that
 * merely resolves to loopback today does not count. */
fun isLoopbackUrl(url: String): Boolean {
    val uri = runCatching { URI(url.trim()) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return false
    val host = uri.host?.lowercase()?.removePrefix("[")?.removeSuffix("]") ?: return false
    if (host == "localhost") return true
    // Only literal addresses: InetAddress.getByName on a literal never does DNS.
    val literalV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""").matches(host)
    val literalV6 = host.contains(':')
    if (!literalV4 && !literalV6) return false
    val address = runCatching { InetAddress.getByName(host) }.getOrNull() ?: return false
    return (address is Inet4Address || address is Inet6Address) && address.isLoopbackAddress
}
