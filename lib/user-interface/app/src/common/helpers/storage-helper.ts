// A thin, typed wrapper over localStorage. Its only caller is
// common/language-context.ts, which persists the parent's language preference.
//
// This used to carry the AWS chatbot template's own storage API as well:
// getTheme/applyTheme, plus navigation-panel state, selected LLM and selected
// workspace. The theme pair went with the Cloudscape removal (nothing had set
// the stored theme since the dark-mode toggle in navigation-panel.tsx was
// deleted, so applyTheme only ever ran with Light, removing a body class
// nothing added and re-writing --app-color-scheme to the value app.scss already
// declares on :root). The other six had zero callers and described concepts
// this app does not have. app.scss keeps `--app-color-scheme: light` on :root,
// which is what actually drives form-control and scrollbar rendering, with no
// JS involved.
export abstract class StorageHelper {
  static getItem(key: string): string | null {
    return localStorage.getItem(key);
  }

  static setItem(key: string, value: string): void {
    localStorage.setItem(key, value);
  }

  static removeItem(key: string): void {
    localStorage.removeItem(key);
  }
}
