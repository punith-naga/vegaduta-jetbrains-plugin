// Vite/vitest `?raw` imports (file contents as a string) - used by the chat
// webview's "no HTML-string sinks" source scan without needing @types/node.
declare module "*?raw" {
  const content: string;
  export default content;
}
