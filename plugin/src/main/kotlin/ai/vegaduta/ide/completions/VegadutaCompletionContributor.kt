// IDE side of on-device completions: a CompletionContributor that asks the
// user's local inference server (LocalCompletionEngine) what belongs at the
// caret and offers the answer as one lookup item.
//
// WHY A CONTRIBUTOR AND NOT THE INLINE (GHOST TEXT) PROVIDER. The plugin's
// sinceBuild is 242 (build.gradle.kts). The inline-completion extension point
// does exist in that range, but it is @ApiStatus.Experimental and its shape
// moved between 2024.1, 2024.2 and 2024.3 - InlineCompletionSuggestion itself
// changed package, and InlineCompletionProvider.getId() is an inline value
// class whose JVM signature is mangled per version (verified by javap against
// the 2025.2 platform available on this machine; no 2024.2 SDK was available
// to compile against). Code written against it blind would risk not loading in
// exactly the IDE range the plugin claims to support. CompletionContributor is
// stable across the whole range, so that is what ships; the ghost-text
// provider is a follow-up to write with the 242 SDK actually on the classpath.
//
// TYPING IS NEVER BLOCKED:
//  - nothing runs on auto-popup, only on an explicit SECOND Ctrl+Space
//    (invocationCount >= 2), so ordinary completion keeps its latency;
//  - the HTTP call happens on a pooled thread, and this thread waits through
//    awaitWithCheckCanceled, which surrenders to a pending write action (the
//    user typing) by throwing ProcessCanceledException;
//  - the engine's own request timeout caps the wait either way.

package ai.vegaduta.ide.completions

import ai.vegaduta.ide.settings.VegadutaSettingsState
import com.intellij.codeInsight.completion.CompletionContributor
import com.intellij.codeInsight.completion.CompletionParameters
import com.intellij.codeInsight.completion.CompletionResultSet
import com.intellij.codeInsight.completion.CompletionType
import com.intellij.codeInsight.completion.PrioritizedLookupElement
import com.intellij.codeInsight.lookup.LookupElementBuilder
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.util.ProgressIndicatorUtils
import com.intellij.openapi.project.DumbAware
import java.util.concurrent.Callable
import java.util.concurrent.Future

class VegadutaCompletionContributor : CompletionContributor(), DumbAware {
    private val log = logger<VegadutaCompletionContributor>()

    override fun fillCompletionVariants(parameters: CompletionParameters, result: CompletionResultSet) {
        if (parameters.completionType != CompletionType.BASIC) return
        if (parameters.isAutoPopup || parameters.invocationCount < MIN_INVOCATION_COUNT) return
        // Off until the user both points the plugin at a local server and ticks
        // the box (VegadutaSettingsState.localCompletionsActive).
        if (!VegadutaSettingsState.getInstance().localCompletionsActive()) return

        val editor = parameters.editor
        val document = editor.document
        val text = document.immutableCharSequence
        val offset = parameters.offset.coerceIn(0, text.length)

        // The window around the caret, sized like the VS Code provider
        // (clients/vscode/src/completions/provider.ts).
        val startLine = (document.getLineNumber(offset) - PREFIX_MAX_LINES).coerceAtLeast(0)
        var prefix = text.subSequence(document.getLineStartOffset(startLine), offset).toString()
        if (prefix.length > PREFIX_MAX_CHARS) prefix = prefix.takeLast(PREFIX_MAX_CHARS)
        if (prefix.isBlank()) return
        val suffix = text.subSequence(offset, (offset + SUFFIX_MAX_CHARS).coerceAtMost(text.length)).toString()

        val request = LocalCompletionRequest(
            prefix = prefix,
            suffix = suffix,
            languageId = parameters.originalFile.language.id.lowercase(),
            deadlineMs = DEADLINE_MS,
        )
        val completion = awaitCompletion(request) ?: return

        // What ends up in the document is the text the user already typed plus
        // the model's continuation: the model saw that typed text as part of
        // `prefix`, so it continues from after it. Keeping the lookup string
        // prefixed with it also keeps the item matching the framework's own
        // prefix matcher instead of being filtered out.
        val typed = result.prefixMatcher.prefix
        val insertText = typed + completion
        val lookupString = typed + label(completion)

        val element = LookupElementBuilder.create(insertText, lookupString)
            .withPresentableText(lookupString)
            .withTypeText("VegaDuta local", true)
            .withInsertHandler { context, _ ->
                context.document.replaceString(context.startOffset, context.tailOffset, insertText)
                context.editor.caretModel.moveToOffset(context.startOffset + insertText.length)
                context.commitDocument()
            }
        // Top of the list: this item only exists because the user asked a
        // second time, so it is the thing they were asking for.
        result.addElement(PrioritizedLookupElement.withPriority(element, PRIORITY))
    }

    /** Runs the blocking engine call off this thread and waits on it in a way
     * that yields to the editor. Returns null for every failure; rethrows
     * ProcessCanceledException, which the platform requires to propagate. */
    private fun awaitCompletion(request: LocalCompletionRequest): String? {
        val engine = service<LocalCompletionEngine>()
        val future: Future<String?> = ApplicationManager.getApplication()
            .executeOnPooledThread(Callable { engine.complete(request) })
        return try {
            ProgressIndicatorUtils.awaitWithCheckCanceled(future)
        } catch (e: ProcessCanceledException) {
            future.cancel(true)
            throw e
        } catch (e: Exception) {
            future.cancel(true)
            log.info("local completion unavailable: ${e.javaClass.simpleName}")
            null
        }
    }

    /** A lookup row is one line: show the first line of the completion and say
     * so when there is more. */
    private fun label(completion: String): String {
        val trimmed = completion.trim()
        val firstLine = trimmed.lineSequence().first().trim()
        val clipped = firstLine.take(LABEL_MAX_CHARS)
        val more = clipped.length < firstLine.length || trimmed.contains('\n')
        val label = if (more) "$clipped ..." else clipped
        return label.ifBlank { "VegaDuta local completion" }
    }

    private companion object {
        /** 0 = auto-popup, 1 = plain Ctrl+Space (left alone so normal
         * completion keeps its speed), 2 = the explicit second press. */
        const val MIN_INVOCATION_COUNT = 2

        /** Longer than the VS Code provider's 1200ms, deliberately: that
         * budget is for ghost text fired on keystrokes, this one is for a
         * gesture the user made and is waiting on. */
        const val DEADLINE_MS = 4_000L
        const val PREFIX_MAX_LINES = 64
        const val PREFIX_MAX_CHARS = 4_000
        const val SUFFIX_MAX_CHARS = 1_000
        const val LABEL_MAX_CHARS = 60
        const val PRIORITY = 1_000.0
    }
}
