export class SankofaAutocapture {
  private onPageView: (source: "initial" | "history") => Promise<void>;
  private historyPatch: {
    originalPushState: History["pushState"];
    originalReplaceState: History["replaceState"];
    popstateListener: () => void;
  } | null = null;

  constructor(options: { onPageView: (source: "initial" | "history") => Promise<void> }) {
    this.onPageView = options.onPageView;
  }

  install(): void {
    if (typeof window === "undefined" || this.historyPatch) {
      return;
    }

    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(window.history);

    const emitPageView = () => {
      void this.onPageView("history");
    };

    window.history.pushState = ((...args: Parameters<History["pushState"]>) => {
      originalPushState(...args);
      emitPageView();
    }) as History["pushState"];

    window.history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
      originalReplaceState(...args);
      emitPageView();
    }) as History["replaceState"];

    const popstateListener = () => emitPageView();
    window.addEventListener("popstate", popstateListener);

    this.historyPatch = {
      originalPushState,
      originalReplaceState,
      popstateListener,
    };
    
    // Initial pageview
    void this.onPageView("initial");
  }

  uninstall(): void {
    if (typeof window === "undefined" || !this.historyPatch) {
      return;
    }

    window.history.pushState = this.historyPatch.originalPushState;
    window.history.replaceState = this.historyPatch.originalReplaceState;
    window.removeEventListener("popstate", this.historyPatch.popstateListener);
    this.historyPatch = null;
  }
}
