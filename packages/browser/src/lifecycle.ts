import type { SankofaFlushOptions } from "./types";
import { SankofaSessionManager } from "./session";

export class SankofaLifecycleObserver {
  private onFlush: (options: SankofaFlushOptions) => Promise<void>;
  private onTrack: (eventName: string, props?: any) => Promise<void>;
  private session: SankofaSessionManager;
  
  private visibilityListener: (() => void) | null = null;
  private pagehideListener: ((event: PageTransitionEvent) => void) | null = null;

  constructor(options: {
    onFlush: (options: SankofaFlushOptions) => Promise<void>;
    onTrack: (eventName: string, props?: any) => Promise<void>;
    session: SankofaSessionManager;
  }) {
    this.onFlush = options.onFlush;
    this.onTrack = options.onTrack;
    this.session = options.session;
  }

  install(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    this.visibilityListener = () => {
      if (document.visibilityState === "hidden") {
        // 🚀 Snapshot the exit time
        this.session.setLastBackgroundTime();
        
        void this.onTrack("$app_backgrounded");
        void this.onFlush({
          keepalive: true,
          reason: "visibilitychange",
        });
        return;
      }
      
      // 🚀 Return to Foreground
      const { rotated } = this.session.refresh();
      if (rotated) {
        void this.onTrack("$session_start");
      }
      void this.onTrack("$app_foregrounded");
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
