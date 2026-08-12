import { NavigationPanelState } from "../types";

// getTheme/applyTheme lived here until the Cloudscape removal. Nothing had set
// the stored theme since navigation-panel.tsx (the dark-mode toggle) was
// deleted, so applyTheme only ever ran with Light: it called Cloudscape's
// applyMode to REMOVE a body class nothing added, and re-wrote
// --app-color-scheme to the value app.scss already declares on :root. The
// static `--app-color-scheme: light` in app.scss keeps doing that job on its
// own, with no JS involved.
const PREFIX = "aws-genai-llm-chatbot";
const SELECTED_MODEL_STORAGE_NAME = `${PREFIX}-selected-model`;
const SELECTED_WORKSPACE_STORAGE_NAME = `${PREFIX}-selected-workspace`;
const NAVIGATION_PANEL_STATE_STORAGE_NAME = `${PREFIX}-navigation-panel-state`;

export abstract class StorageHelper {
  static getNavigationPanelState(): NavigationPanelState {
    const value =
      localStorage.getItem(NAVIGATION_PANEL_STATE_STORAGE_NAME) ??
      JSON.stringify({
        collapsed: true,
      });

    let state: NavigationPanelState | null = null;
    try {
      state = JSON.parse(value);
    } catch {
      state = {};
    }

    return state ?? {};
  }

  static setNavigationPanelState(state: Partial<NavigationPanelState>) {
    const currentState = this.getNavigationPanelState();
    const newState = { ...currentState, ...state };
    const stateStr = JSON.stringify(newState);
    localStorage.setItem(NAVIGATION_PANEL_STATE_STORAGE_NAME, stateStr);

    return newState;
  }

  static getSelectedLLM() {
    const value = localStorage.getItem(SELECTED_MODEL_STORAGE_NAME) ?? null;

    return value;
  }

  static setSelectedLLM(model: string) {
    localStorage.setItem(SELECTED_MODEL_STORAGE_NAME, model);
  }

  static getSelectedWorkspaceId() {
    const value = localStorage.getItem(SELECTED_WORKSPACE_STORAGE_NAME) ?? null;

    return value;
  }

  static setSelectedWorkspaceId(workspaceId: string) {
    localStorage.setItem(SELECTED_WORKSPACE_STORAGE_NAME, workspaceId);
  }

  // Add these methods to the existing StorageHelper class
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
