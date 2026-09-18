// EdgeHost - the injected environment seam for the ported edge layer.
//
// The web originals (web/app/lib/edge/*.ts) are coupled to web's `../api`
// (API_BASE), `../auth` (bearer tokens) and raw localStorage. Every module in
// clients/shared/src/edge/ takes an EdgeHost instead, so the same code runs in
// a VS Code webview, the Chrome side panel and (if JCEF ever gains WebGPU) a
// JetBrains webview without touching globals it can't rely on.

export interface EdgeKv {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface EdgeHost {
  /** Platform API origin, e.g. https://api.vegaduta.xyz (staging) or
   * https://api.vegaduta.ai (prod). NEVER a localhost default - RULE 0. */
  apiBase: string;
  /** Bearer token for authenticated edge endpoints; null when signed out.
   * The manifest endpoint is permitAll, so the edge layer works unsigned. */
  getToken(): Promise<string | null>;
  /** Preference/marker store (replaces web's raw localStorage use). */
  kv: EdgeKv;
  platform: "vscode" | "chrome" | "jetbrains" | "eclipse";
}

/** localStorage-backed EdgeKv when the environment has one (webviews do),
 * falling back to a per-page in-memory map. All reads/writes are guarded -
 * a blocked/full localStorage degrades silently, same posture as web's
 * safeLocalGet/safeLocalSet. */
export function createDefaultKv(): EdgeKv {
  const memory = new Map<string, string>();
  return {
    get(key: string): string | null {
      try {
        if (typeof localStorage !== "undefined") {
          return localStorage.getItem(key);
        }
      } catch {
        // Fall through to memory.
      }
      return memory.get(key) ?? null;
    },
    set(key: string, value: string): void {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(key, value);
          return;
        }
      } catch {
        // Fall through to memory.
      }
      memory.set(key, value);
    },
  };
}
