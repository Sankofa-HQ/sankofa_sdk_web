import type { SankofaFlushOptions } from "./types";

export class SankofaLifecycleObserver {
  private onFlush: (options: SankofaFlushOptions) => Promise<void>;
  private onActivity: (source: string) => void;
  
  private visibilityListener: (() => void) | null = null;
  private pagehideListener: ((event: PageTransitionEvent) => void) | null = null;

  constructor(options: {
    onFlush: (options: SankofaFlushOptions) => Promise<void>;
    onActivity: (source: string) => void;
  }) {
    this.onFlush = options.onFlush;
    this.onActivity = options.onActivity;
  }

  install(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    this.visibilityListener = () => {
      if (document.visibilityState === "hidden") {
        void this.onFlush({
          keepalive: true,
          reason: "visibilitychange",
        });
        return;
      }
      this.onActivity("visibilitychange");
    };

    this.pagehideListener = () => {
      void this.onFlush({
        keepalive: true,
        reason: "pagehide",
      });
    };

    document.addEventListener("visibilitychange", this.visibilityListener);
    window.addEventListener("pagehide", this.pagehideListener);
  }

  uninstall(): void {
    if (typeof document !== "undefined" && this.visibilityListener) {
      document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = null;
    }

    if (typeof window !== "undefined" && this.pagehideListener) {
      window.removeEventListener("pagehide", this.pagehideListener);
      this.pagehideListener = null;
    }
  }
}
