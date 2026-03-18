export type ActivityListener = {
  target: Window | Document;
  type: string;
  listener: EventListener;
  options?: AddEventListenerOptions;
};

const USER_ACTIVITY_TOUCH_THROTTLE_MS = 15_000;

export class SankofaActivityObserver {
  private onActivity: (source: string) => void;
  private lastActivityTouchAt = 0;
  private listeners: ActivityListener[] = [];

  constructor(options: { onActivity: (source: string) => void }) {
    this.onActivity = options.onActivity;
  }

  install(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    if (this.listeners.length > 0) {
      return;
    }

    const register = (
      target: Window | Document,
      type: string,
      options?: AddEventListenerOptions,
    ) => {
      const listener: EventListener = () => {
        const now = Date.now();
        if (now - this.lastActivityTouchAt >= USER_ACTIVITY_TOUCH_THROTTLE_MS) {
          this.lastActivityTouchAt = now;
          this.onActivity(type);
        }
      };
      target.addEventListener(type, listener, options);
      this.listeners.push({ target, type, listener, options });
    };

    register(window, "focus");
    register(window, "pointerdown", { passive: true });
    register(window, "keydown");
    register(window, "scroll", { passive: true });
    register(document, "click", { passive: true });
  }

  uninstall(): void {
    this.listeners.forEach(({ target, type, listener, options }) => {
      target.removeEventListener(type, listener, options);
    });
    this.listeners = [];
  }
}
