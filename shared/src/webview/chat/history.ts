// Local conversation history for the chat webview.
//
// What is stored: the visible text of user/assistant turns, context-chip
// LABELS (never the attached file/diff/page text), the thread's mode, the
// hosted agent id and the hosted session id (a server-side conversation id,
// not a credential). Never tokens, never API keys, never attachment bodies.
//
// localStorage can be missing, full, or throw on every access (private
// windows, blocked site data, some webview configurations). Every access is
// guarded; a store that cannot persist keeps working in memory and says so
// through `persistent`.

export type ThreadMode = "hosted" | "local";

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  /** Labels of context chips that were attached to this turn. */
  context?: string[];
  /** Slash command this turn came from ("commit", "review", ...). */
  command?: string;
  /** True when the turn ended in an error (not replayed to local models). */
  error?: boolean;
}

export interface Thread {
  id: string;
  title: string;
  mode: ThreadMode;
  agentId?: string | null;
  sessionId?: string | null;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const HISTORY_KEY = "vegaduta.chat.threads.v1";
export const MAX_THREADS = 40;
export const MAX_MESSAGES_PER_THREAD = 200;
/** Per-message ceiling so one enormous answer cannot evict everything else. */
export const MAX_STORED_MESSAGE_CHARS = 40_000;

function isThread(value: unknown): value is Thread {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<Thread>;
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    (t.mode === "hosted" || t.mode === "local") &&
    Array.isArray(t.messages)
  );
}

function sanitizeMessage(value: unknown): StoredMessage | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Partial<StoredMessage>;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return null;
  return {
    role: m.role,
    text: m.text.slice(0, MAX_STORED_MESSAGE_CHARS),
    ...(Array.isArray(m.context) ? { context: m.context.filter((c) => typeof c === "string").slice(0, 10) } : {}),
    ...(typeof m.command === "string" ? { command: m.command } : {}),
    ...(m.error === true ? { error: true } : {}),
  };
}

export class HistoryStore {
  private threads: Thread[] = [];
  persistent = true;
  private counter = 0;

  constructor(private readonly storage: KeyValueStorage | null, private readonly now: () => number = () => Date.now()) {
    this.load();
  }

  private load(): void {
    if (!this.storage) {
      this.persistent = false;
      return;
    }
    try {
      const raw = this.storage.getItem(HISTORY_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      this.threads = parsed.filter(isThread).map((t) => ({
        ...t,
        messages: t.messages.map(sanitizeMessage).filter((m): m is StoredMessage => m !== null),
      }));
    } catch {
      // Corrupt JSON or a throwing accessor: start empty, keep going.
      this.threads = [];
    }
  }

  private save(): void {
    if (!this.storage) return;
    this.threads.sort((a, b) => b.updatedAt - a.updatedAt);
    this.threads = this.threads.slice(0, MAX_THREADS);
    // Quota errors: drop the oldest threads until it fits (or nothing left).
    for (let keep = this.threads.length; keep >= 0; keep -= 1) {
      try {
        const nonEmpty = this.threads.slice(0, keep).filter((t) => t.messages.length > 0);
        this.storage.setItem(HISTORY_KEY, JSON.stringify(nonEmpty));
        this.persistent = true;
        return;
      } catch {
        this.persistent = false;
        if (keep === 0) return;
      }
    }
  }

  list(): Thread[] {
    return [...this.threads]
      .filter((t) => t.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Thread | undefined {
    return this.threads.find((t) => t.id === id);
  }

  create(mode: ThreadMode, agentId: string | null): Thread {
    this.counter += 1;
    const t: Thread = {
      id: `t${this.now().toString(36)}${this.counter}`,
      title: "New chat",
      mode,
      agentId: mode === "hosted" ? agentId : null,
      sessionId: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      messages: [],
    };
    this.threads.push(t);
    return t;
  }

  append(id: string, message: StoredMessage, title?: string): void {
    const t = this.get(id);
    if (!t) return;
    const clean = sanitizeMessage(message);
    if (!clean) return;
    t.messages.push(clean);
    if (t.messages.length > MAX_MESSAGES_PER_THREAD) t.messages.splice(0, t.messages.length - MAX_MESSAGES_PER_THREAD);
    if (title && t.title === "New chat") t.title = title;
    t.updatedAt = this.now();
    this.save();
  }

  /** Remove the last message if it is an assistant turn (used by Retry). */
  popAssistant(id: string): void {
    const t = this.get(id);
    if (!t) return;
    if (t.messages[t.messages.length - 1]?.role === "assistant") {
      t.messages.pop();
      this.save();
    }
  }

  setSession(id: string, sessionId: string | null): void {
    const t = this.get(id);
    if (!t || t.sessionId === sessionId) return;
    t.sessionId = sessionId;
    this.save();
  }

  delete(id: string): void {
    this.threads = this.threads.filter((t) => t.id !== id);
    this.save();
  }

  clearAll(): void {
    this.threads = [];
    if (!this.storage) return;
    try {
      this.storage.removeItem(HISTORY_KEY);
    } catch {
      // Nothing else to do - in-memory state is already empty.
    }
  }
}

/** localStorage, or null when touching it throws. */
export function safeLocalStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "vegaduta.chat.probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}
