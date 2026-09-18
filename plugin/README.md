# VegaDuta for JetBrains IDEs

VegaDuta brings AI help into IntelliJ IDEA, PyCharm, WebStorm, GoLand and the other
IntelliJ-based IDEs (2024.2 and newer). You can chat about your code, review your
uncommitted changes, draft commit messages, write tests and docs, and run a coding
agent on your project.

You can use it in two ways:

- **Free, with no account.** Run an OpenAI-compatible model server on your own
  machine, such as [Ollama](https://ollama.com), LM Studio or llama.cpp. Your code
  goes only to that server.
- **Signed in to VegaDuta.** Chat with your organisation's VegaDuta agents and run
  its workflows.

> **Maintainers: this directory is published under Apache-2.0 and mirrored publicly.**
> JetBrains Marketplace needs a source-code link for plugins with an open-source
> licence, so `clients/jetbrains` and `clients/shared` are mirrored to
> <https://github.com/punith-naga/vegaduta-jetbrains-plugin> (as `plugin/` and
> `shared/`). Plugin 33539's Technical Information links to that repo.
> **Re-sync that repo on every Marketplace release.** Treat both directories as
> public: no secrets, no internal hostnames and no private doc paths.

---

## Install

1. In the IDE, open **Settings | Plugins | Marketplace**, search for **VegaDuta**
   and click **Install**.
2. To install a build you downloaded instead, open **Settings | Plugins**, click
   the gear icon, choose **Install Plugin from Disk…** and pick the
   `vegaduta-jetbrains-<version>.zip` file.

After installing, the VegaDuta tool window appears on the right-hand side of the
IDE. The plugin also adds a **Tools | VegaDuta** menu and a **VegaDuta** submenu
to the editor's right-click menu.

## Quick start: free, on your own machine

1. Start a model server. With Ollama, for example:
   `ollama pull qwen2.5-coder:7b` and then `ollama serve`.
2. Open **Settings | Tools | VegaDuta** and click **Detect local server**. The
   plugin tries `127.0.0.1` on ports 11434 (Ollama), 1234 (LM Studio) and 8080
   (llama.cpp), and fills in the first one that answers. You can also type the URL
   and model name yourself.
3. Tick **Code completions from the local server** if you want completions.

That gives you:

- **Chat in the tool window, in On-device mode.** Every message goes only to the
  server you configured. The one-click actions below also work in this mode.
- **Code completions.** Invoke basic completion twice (Ctrl+Space twice on Windows
  and Linux) and your model's suggestion is added to the completion list.
- **Start a Coding Task** (see [Coding agent](#coding-agent)). This needs a model
  that supports tool calling, such as `qwen2.5-coder`, `llama3.1`, `mistral-nemo`
  or `devstral`.

The plugin does not download or run models itself. The chat panel runs in the
IDE's built-in browser (JCEF), which has no WebGPU, so "on-device" here always
means a server you started yourself. (The VS Code and Chrome extensions can
download a model onto your GPU. This plugin can't.)

## Sign in (for hosted agents and workflows)

1. Choose **Tools | VegaDuta | Sign In…**, or click **Sign in** in the tool window
   or in **Settings | Tools | VegaDuta**.
2. Your browser opens the VegaDuta sign-in page with a code already filled in.
   Approve it there.
3. The IDE finishes signing in by itself. It uses the OAuth device flow, so it
   never opens a local port, and it works over Remote Development and SSH.

Your session is stored in the operating system's keychain (credential service
"VegaDuta IDE") and lasts about 30 days. **Sign out** is in the tool window and
in Settings.

**Headless use:** in **Settings | Tools | VegaDuta**, click **Paste API key…** and
paste a scoped `vmcp_` key from your administrator. In this mode, replies arrive
as one complete message instead of streaming.

## Commands

| Command | Where | What it does |
|---|---|---|
| **Review My Changes** | Tools \| VegaDuta; editor right-click \| VegaDuta | Attaches your uncommitted diff and asks for a review: real problems first, each with the file and line. |
| **Generate Commit Message with VegaDuta** | Toolbar above the commit message box; Tools \| VegaDuta; editor right-click | Attaches your diff and drafts a commit message. Click **Use as commit message** on the answer to fill in the commit box. It never commits for you. |
| **Write Tests for Selection** | Editor right-click (needs a selection); Tools \| VegaDuta | Attaches the selection and the rest of its file, and asks for runnable unit tests in your project's test framework. |
| **Add Docs to Selection** | Editor right-click (needs a selection); Tools \| VegaDuta | Asks for documentation comments in the language's usual style (KDoc, Javadoc, docstrings and so on) without changing behaviour. |
| **Explain Selection** / **Refactor Selection** | Editor right-click (needs a selection); Tools \| VegaDuta | Puts the selected code into the chat with that instruction. |
| **Start a Coding Task…** | Tools \| VegaDuta | Runs the multi-step [coding agent](#coding-agent) on the open project. |
| **Run Workflow…** | Tools \| VegaDuta | Signed in only. Pick one of your VegaDuta workflows, run it and follow its progress. |
| **Sign In…** | Tools \| VegaDuta | See [Sign in](#sign-in-for-hosted-agents-and-workflows). |

Review, Commit Message, Tests and Docs open the tool window, put the prompt in
the message box, attach the context it needs and send it. If you're signed in,
the message goes to the VegaDuta agent you picked. If you're not, it goes to your
local server in On-device mode. If neither is available, the tool window asks you
to sign in or set up a local server.

**Where the commit message goes.** When you start **Generate Commit Message**
from the commit toolbar, the plugin remembers that box, and **Use as commit
message** fills it in. When you start it from a menu, the plugin uses the commit
box you last started it from. If there isn't one, or the Commit tool window has
been closed, it copies the message to the clipboard and a notification tells you.

## Chat and context

The tool window streams answers. You can attach any of these to a message:

| Attachment | What is attached |
|---|---|
| **File** | The file open in the editor. Its label is the file's path within the project. |
| **Selection** | The text selected in that editor. |
| **Diff** | Your uncommitted changes. This works with any version control the IDE manages. If none is set up and the project folder is a git repository, the plugin runs `git diff HEAD` instead. Files not yet added to version control are not included. |
| **Problems** | The errors and warnings the IDE currently shows for the open file, with line numbers. These come from the IDE's most recent check of that file. |
| **Recent commits** | The last 30 commits of the project's git repository, newest first: short hash, date, author name (no e-mail address), subject and message body. Useful for a commit message in your team's own style, release notes or a standup summary. The plugin runs `git log` in the repository root, so git must be on your `PATH`. Very long commit messages are shortened and marked. |

The terminal's selection can't be attached in this IDE: the IntelliJ Platform
has no public, stable way to read it, so the plugin doesn't offer it.

Each attachment is capped at 24,000 characters and marked as truncated when it
was cut. If the plugin can't provide an attachment, for example because nothing
is selected, there is no uncommitted change or no file is open, the chat shows
the reason instead of attaching something empty.

You can use an answer in three ways:

- **Insert** puts the code at the cursor, or replaces the selection if there is
  one. Ctrl+Z undoes it. If no file is open, or the file is read-only, the code is
  copied to the clipboard and a notification tells you.
- **Open in new file** creates a scratch file (under **Scratches and Consoles**)
  and opens it in the editor.
- **Copy** copies the code to the clipboard.

A **Run** button runs a Python, JavaScript/TypeScript or bash code block in a
disposable cloud sandbox. It's only available when you're signed in and your
administrator has given you the role for it.

**Jump to the code.** When an answer points at lines in a project file (a Code
Tour, for example), the plugin opens that file and selects those lines. It only
opens files inside the project folder: a path that climbs out of it, an absolute
path elsewhere, or a symbolic link pointing outside is refused with a
notification.

**Team knowledge search.** When you're signed in (not with a `vmcp_` API key),
the chat can search your organisation's VegaDuta knowledge base and use what it
finds. The search runs from the IDE with your session; the chat page never sees
your token.

## Private Mode

Turn on Private Mode from the chat panel, or tick **Private Mode** in
**Settings | Tools | VegaDuta**. Both set the same switch, it applies to every
open project, and it stays on after you restart the IDE. While it's on, the
status line under the chat says so.

While Private Mode is on, **no prompt, code, attachment or search query leaves
your machine**:

- **Still works:** chat and code completions with your own local model server,
  and the coding agent when its endpoint is on this machine (`localhost`,
  `127.x.x.x` or `::1`, or left empty so it detects a local server).
- **Blocked:** hosted chat with VegaDuta agents, knowledge search, the **Run**
  sandbox, workflow runs (including **Tools | VegaDuta | Run Workflow…**), and a
  coding agent pointed at a hosted provider. The IDE refuses these itself, before
  any request is made, and tells you why.

Private Mode does not mean the plugin never uses the network. Signing in, and
listing your agents and workflows, still reach VegaDuta; they carry none of your
content. Your own local server is reached over your machine's loopback
interface.

If the IDE's built-in browser is turned off, the tool window shows a simpler
panel instead. It supports signed-in chat and the same commands. Context is
attached to the next message you send, and the status line lists what was
attached. That panel never sends a message on its own; press Enter to send.

## Coding agent

**Tools | VegaDuta | Start a Coding Task…** runs a real multi-step agent
against your open project. Describe the task, for example "the date parser drops
time zones, find out why and fix it, then run the tests". The agent explores the
project, reads the files it needs, makes the edit, runs your tests and reports
what it did. Its progress appears in the **VegaDuta Agent** console at the
bottom of the IDE. Cancelling the background progress task stops the run and
ends any command that is still running.

The agent has six tools: `list_dir`, `read_file`, `search_text`, `write_file`,
`edit_file` and `run_command`. `edit_file` replaces an exact snippet instead of
rewriting the whole file, so a three-line fix changes three lines. Edits go
through the IDE's undo stack, so **Ctrl+Z undoes what the agent did**. Undoing
a file the agent created empties the file but doesn't delete it.

**No account needed.** The agent talks to an OpenAI-compatible endpoint: either
your own local server (no key, no quota) or a provider you hold a key for. It
never contacts VegaDuta and never checks whether you're signed in. Leave the
endpoint blank and it uses the same local-server detection as Settings.

The model must support tool calling. A model that doesn't gets a clear error
saying so.

### What it asks before doing

Reading and searching run without asking. **Every edit and every command asks
first**, in a dialog that names the file or shows the exact command line. Each
prompt offers *Allow*, *Allow all … this run* and *Stop the agent*. "Allow all"
lasts only for that run and is never saved. The two auto-approve boxes in
Settings change these defaults. The commands box lets a model run any command on
your machine, and the dialog warns you about that.

Two further limits:

- **Nothing outside the project folder.** Every path the model gives is checked
  against the project root, including through symbolic links. A path like
  `../../.ssh/id_rsa` returns an error, not a file.
- **Limited steps.** A run stops after "Max steps per task" (60 by default,
  1–300). A model that repeats the same call three times is told to try something
  else.

A short blocklist refuses a few destructive commands outright: deleting a drive
or filesystem root, `mkfs` and `diskpart`, raw device writes, fork bombs,
`git push --force` and shutdown. This is a safety net under the approval prompt,
**not a sandbox**. The agent runs with your user's permissions in your shell, so
treat it like a script a colleague sent you.

## Settings (Settings | Tools | VegaDuta)

| Setting | Default | Notes |
|---|---|---|
| Environment | production | `production` (vegaduta.ai), `staging` (vegaduta.xyz), or `custom` for a self-hosted install. |
| Local inference server / Local model | empty | Used by chat in On-device mode and by code completions. **Detect local server** fills both in. |
| Code completions from the local server | off | |
| Agent endpoint | empty | Empty means the local-server detection above. Or a provider address, such as `https://api.groq.com/openai`. |
| Agent model | empty | Empty means the first model the server lists. It must support tool calling. |
| Max steps per task | `60` | 1–300 |
| Apply the agent's file edits without asking | off | |
| Run the agent's shell commands without asking | off | Lets a model run any command as you. |
| Private Mode | off | See [Private Mode](#private-mode). The chat panel's switch sets the same value. |

Set a provider key with **Set agent API key…**. It is stored in the operating
system's keychain, not in settings, because settings sync between machines and
appear in screen shares. It is kept separate from the `vmcp_` key and is never
sent to VegaDuta.

With `custom` selected, a base URL you leave blank falls back to the **staging**
address, so fill in both.

## What leaves your machine

- **On-device chat, completions and the coding agent** send data only to the
  server or provider you configured. With a local server, nothing leaves your
  machine. With a hosted provider, the code, search results and command output
  the agent reads go to that provider, under your key.
- **Signed-in chat, knowledge search, workflows and Run** go to the VegaDuta API
  for your chosen environment. That includes your messages, your search queries
  and anything you attach. [Private Mode](#private-mode) blocks all of them.
- Your sign-in session is stored in the operating system's keychain. Your access
  token never enters the chat panel's web page: the IDE side makes the network
  calls.

## Troubleshooting

**Sign-in fails with "Offline tokens are not allowed for this user".**
This was a problem with the account, not the plugin. Some accounts were created
without a default role they needed, and every client, not only this plugin,
rejected their sign-in. It was fixed on the server on 18 September 2026. If you
still see this message, ask your VegaDuta administrator to restore the default
roles on your account, then sign in again. Reinstalling the plugin won't help.

**The status line under the chat says "On-device engine: off".** The rest of the
line gives the reason:

- no server URL is set;
- nothing answers at the URL;
- the server answered but lists no models;
- the server refused the request.

Start your server, or fix the URL in Settings. The chat panel reads the URL when
it opens, so if you change the URL, close and reopen the project.

**No local completions appear.** Check that the completions box is ticked and a
server is set, then invoke completion **twice** (Ctrl+Space twice). A single
invocation shows only the IDE's own suggestions.

**"Use as commit message" copied the text instead of filling in the box.** Open
the Commit tool window, then start **Generate Commit Message with VegaDuta** from
the toolbar above the message box. That lets the plugin remember the box.

**The Diff attachment says "not a git repository".** No version control is set up
for the project in the IDE (**Settings | Version Control**), and the project
folder has no `.git` directory.

**The tool window shows a plain panel instead of the chat.** The IDE's built-in
browser (JCEF) is turned off or unsupported in this IDE. Everything still works,
but the panel is simpler.

---

## For developers

IntelliJ Platform plugin: Kotlin, `org.jetbrains.intellij.platform` Gradle plugin
2.x, `sinceBuild 242` (2024.2).

### Layout

```
build.gradle.kts          intellij-platform 2.x, kotlinx.serialization, copyWebview task
src/main/resources/META-INF/plugin.xml      (its <description> IS the Marketplace listing)
src/main/resources/META-INF/vegaduta-vcs.xml (commit-toolbar action; optional VCS depends)
src/main/kotlin/ai/vegaduta/ide/
  agent/      AgentTypes, OpenAiCompatibleModel, AgentLoop, CodingTools,
              LocalEndpoints (discovery), ProjectToolExecutor (the VFS/process half)
  api/        Models.kt (wire DTOs), ApiClient.kt (java.net.http), SseEventReader.kt
  auth/       DeviceFlowLoginService.kt (RFC 8628), TokenStore.kt (PasswordSafe)
  api/        KnowledgeWire.kt (pure: knowledge.search body + hit mapping)
  context/    ContextFormat.kt (pure: truncation, unified diff, labels),
              GitLogFormat.kt (pure: gitlog parsing/formatting, git root),
              RevealTarget.kt (pure: ui.reveal path containment, line range),
              IdeContextCollector.kt (context.request), HostEditorOps.kt
              (ui.insert / ui.newFile / ui.setCommitMessage / ui.reveal,
              CommitMessageTarget)
  privacy/    PrivateMode.kt (pure: the Private Mode policy and loopback check)
  settings/   VegadutaSettingsState.kt, VegadutaConfigurable.kt
  toolwindow/ ChatToolWindowFactory.kt, JcefBridge.kt (webview host), SwingChatPanel.kt,
              AgentConsole.kt (the agent's trace tool window)
  actions/    SignInAction, Explain/RefactorSelection, PrefillActions (Review,
              Commit Message, Tests, Docs), RunWorkflowAction, StartCodingTaskAction
src/test/kotlin/ai/vegaduta/ide/  plain JUnit 5, no IDE fixture needed
```

### The webview host (`JcefBridge`)

`JcefBridge` implements the host side of `clients/shared/src/webview/protocol.ts`
over JCEF. `init` advertises these `capabilities`:

- `context: ["file", "selection", "diff", "diagnostics", "gitlog"]` (no
  `"terminal"`: there is no public, stable terminal-selection API in 242+)
- `insert`, `newFile`, `runCode` and `commitMessage`, all `true`
- wave 2: `reveal`, `knowledge` and `privateMode`, all `true`. `knowledge` is
  serviced for a JWT sign-in only; the chat app offers it only when
  `auth.mode === "jwt"`, and an API-key request is answered `signed-out` without
  a request being made.

Right after `init` the host also posts `privacy.state` with the persisted Private
Mode, so a newly opened window matches what the host enforces.

`init` is always delivered before anything that was queued while the page booted,
so a `ui.prefill` from an action that opened the tool window arrives after the
app knows the capabilities.

- `context.request` runs on a pooled thread. Editor state is read on the EDT
  inside a read action (`invokeAndWait`, `ModalityState.any()`). VCS revisions are
  read on the pooled thread. Diagnostics come from
  `DaemonCodeAnalyzerEx.processHighlights` at WARNING and above. The diff is built
  from `ChangeListManager` + `ComparisonManager`, with `git diff HEAD` as a
  fallback. The unversioned-file list is not included.
- `ui.setCommitMessage` writes to the `CommitMessageI` captured from
  `VcsDataKeys.COMMIT_MESSAGE_CONTROL` by the `Vcs.MessageActionGroup` action. The
  handle is held weakly and treated as gone once its component is no longer
  displayable. When it's gone, the host copies the message and notifies the user.
- `gitlog` runs `git log -n 30 --format=...` (author name, never e-mail) in the
  IDE's Git VCS root, else the nearest folder above the project holding `.git`,
  with a 15-second timeout.
- `ui.reveal` resolves the path on a pooled thread (`resolveRevealPath`: rejects
  `..` escapes, absolute paths elsewhere, and symlinks whose real path is outside
  the project), then on the EDT opens it with `OpenFileDescriptor` and selects the
  1-based inclusive range, clamped to the file. No path = the active editor.
- `knowledge.search` → `POST /api/knowledge/search` through `ApiClient` with the
  stored token; rows map to `KnowledgeHit`. Failures carry `signed-out`,
  `forbidden` or `unavailable`.
- `privacy.mode` sets `VegadutaSettingsState.privateMode` (persisted, app-wide);
  every open bridge replies `privacy.state {private, enforced: true}` and shows
  or hides its status line. The gate is enforced twice: `JcefBridge` answers
  `chat.send`, `workflow.run`, `sdlc.run` and `knowledge.search` with a typed
  refusal, and `ApiClient` refuses `streamChat`, `runWorkflow`, `runCode` and
  `searchKnowledge` before building a request (which also covers the Swing panel
  and the Run Workflow action). `StartCodingTaskAction` refuses a non-loopback
  agent endpoint. JetBrains has no hosted completions or hosted code validation,
  so there is nothing more to gate.
- The access token never enters the webview. SSE runs host-side and arrives as
  `chat.chunk`.

Only public, non-experimental API is used. `./gradlew verifyPlugin` reports
**Compatible** against IC 2024.2.6.

### `agent/`: a Kotlin port kept in step by hand

`agent/` is a Kotlin port of `shared/src/agent/`: the types, the
OpenAI-compatible model adapter, the multi-step loop, the six coding tool specs
and local-endpoint discovery. The TypeScript agent layer can't be reused here,
because this plugin only consumes shared/'s *built webview bundle*, and the tools
need to touch the IDE's VFS and spawn processes, which a JCEF page can't do.
**Keep the two copies in step by hand.** A model prompted for one toolset and
handed another degrades without any error.

`ProjectToolExecutor` has no TypeScript counterpart. It is the IntelliJ
implementation of the six tools, and it holds the path containment, the approval
gate and the command blocklist.

### Local inference in the chat panel

JCEF has no WebGPU, so WebLLM can never load in it. `JcefBridge` sends
`hostLocalEngine: true` **only when a local server URL is configured**. It also
seeds the page's edge kv with `edge.backend = "ollama"` and
`edge.modelOverride = "hosted"`. As a result, the shared chat app starts its
engine host against the WebGPU-free backend (`shared/src/edge/ollamaEngine.ts`)
and skips WebLLM every time. The native status label under the browser re-probes
the server itself (`LocalCompletionEngine.probeLocalServer`), so its "off" reason
comes from the host.

### Build & run

The Gradle wrapper is committed, and JDK 21 is provisioned automatically through
the foojay toolchain resolver. In the public mirror, `clients/jetbrains` and
`clients/shared` are `plugin/` and `shared/`.

```bash
cd clients/jetbrains
./gradlew runIde                       # sandbox IDE with the plugin
./gradlew test                         # JUnit 5 unit tests
./gradlew buildPlugin                  # -> build/distributions/vegaduta-jetbrains-0.3.0.zip
./gradlew verifyPlugin                 # JetBrains Plugin Verifier, must say "Compatible"
```

The first run downloads IntelliJ IDEA Community 2024.2 (about 1 GB). Build the
chat webview first so `copyWebview` can pick it up. Without it, the tool window
falls back to the Swing panel.

```bash
cd ../shared && npm install && npm run build:webview   # writes dist/webview/
```

`src/main/resources/webview/` is a build-time copy and is gitignored.

Publishing: `JETBRAINS_MARKETPLACE_TOKEN=perm:... ./gradlew publishPlugin` (see
`build.gradle.kts`). The token is read only from the environment.

### Environments and Keycloak

None of the three environments defaults to a localhost address. The only
loopback address the plugin uses is your own inference server. The Keycloak
realm (`agentic-ai`) must contain the public client `agentic-ai-ide` with
`oauth2.device.authorization.grant.enabled = true`. VegaDuta's own deployments
already have it. Self-hosters set it once in their own realm.

### Verification state

These have been **compiled**, **unit-tested** (`./gradlew test`) and **passed
`verifyPlugin` (Compatible)**:

- the agent core and path containment;
- the SSE reader;
- the context helpers: truncation, unified-diff formatting, labels and the
  language-to-extension map;
- the wave-2 pure helpers: the Private Mode policy and its persisted flag,
  `ui.reveal` path containment and line clamping, `gitlog` parsing, formatting
  and truncation, and the knowledge-search request/response mapping. (The
  symlink case of path containment is skipped on a Windows machine that can't
  create symlinks.)

These have been compiled but **not yet exercised in a running IDE**:

- the IDE-facing parts of 0.3.0: context collection, the four new actions, the
  commit-toolbar button, scratch files and commit-box fill;
- the coding agent's UI wiring;
- the IDE-facing parts of wave 2: the `git log` process, `ui.reveal` in a real
  editor, a real knowledge search against the API, and the Private Mode status
  line and Settings checkbox.

The smoke tests below are the outstanding steps, not a record of tests that
passed.

### Smoke test (`./gradlew runIde`)

1. Sign in against staging and send a chat message. Check the spacing between
   words in the streamed reply.
2. Signed out, with Ollama running and the local server set, make an edit to a
   file in a git project. Then run **Tools | VegaDuta | Review My Changes**. The
   tool window should open, show a Diff chip and send the message.
3. Open the Commit tool window and click the VegaDuta button above the message
   box. Then click **Use as commit message** on the answer. The box should fill in
   and nothing should be committed.
4. Select a function and run **Write Tests for Selection**. Then click **Open in
   new file** on the answer. A scratch file should open.
5. Attach Problems on a file with a deliberate error. The chip should list it
   with its line number.
6. Close every editor and ask for File context. The chat should report that no
   file is open, not attach an empty file.
7. Coding agent, signed out: Ollama with a tool-calling model and an empty agent
   endpoint. Check that:
   - the console names the discovered model;
   - *Stop the agent* ends the run;
   - Ctrl+Z undoes an approved edit;
   - cancelling during `run_command` ends the process;
   - `../../.ssh/id_rsa` returns an error.
8. To test the Swing fallback, add `-Dide.browser.jcef.enabled=false` to the
   sandbox VM options.
9. Attach Recent commits in a git project: the chip should list 30 commits (or
   fewer), newest first, with no e-mail addresses.
10. Turn on Private Mode in Settings. The status line under the chat should say
    so; a hosted chat message, **Run**, a workflow run and a knowledge search
    should each be refused with the reason, and chat with a local server should
    still work. Restart the IDE: it should still be on.
11. Ask for a Code Tour and click a step: the file opens with those lines
    selected. A step pointing at `../` outside the project shows a refusal.
