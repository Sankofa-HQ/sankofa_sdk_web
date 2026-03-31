import { SESSION_TIMEOUT_MS, randomId } from "./utils";

export interface SessionState {
  id: string;
  lastActivityAt: number;
  lastBackgroundAt?: number;
}

export class SankofaSessionManager {
  private prefix: string;
  private _state: SessionState | null = null;

  constructor(options: { prefix: string }) {
    this.prefix = options.prefix;
    this.refresh();
  }

  get state(): SessionState {
    if (!this._state) {
      this._state = this.startNewSession();
    }
    return { ...this._state };
  }

  get sessionId(): string {
    return this.state.id;
  }

  /**
   * Refreshes the session state.
   * Returns whether a rotation occurred.
   */
  refresh(): { previous: SessionState | null; current: SessionState; rotated: boolean } {
    const previous = this._state ? { ...this._state } : null;
    const now = Date.now();
    const stored = this.read();
    let rotated = false;

    // 🚀 Background Rotation Logic (Enterprise Standard)
    const lastBackground = stored?.lastBackgroundAt ?? 0;
    const backgroundElapsed = lastBackground > 0 ? now - lastBackground : 0;

    if (!stored || (lastBackground > 0 && backgroundElapsed > SESSION_TIMEOUT_MS)) {
      this._state = this.startNewSession();
      rotated = true;
    } else {
      this._state = {
        ...stored,
        lastActivityAt: now,
      };
      this.save();
    }

    return { previous, current: this.state, rotated };
  }

  setLastBackgroundTime(): void {
    if (!this._state) return;
    this._state.lastBackgroundAt = Date.now();
    this.save();
  }

  startNewSession(): SessionState {
    const nextSession: SessionState = {
      id: randomId("sess_"),
      lastActivityAt: Date.now(),
    };
    this._state = nextSession;
    this.save();
    return nextSession;
  }

  private storageKey(name: string): string {
    return `${this.prefix}:${name}`;
  }

  private read(): SessionState | null {
    try {
      if (typeof window === "undefined") return null;
      const rawValue =
        window.localStorage.getItem(this.storageKey("session")) ??
        window.sessionStorage.getItem(this.storageKey("session"));
      
      if (!rawValue) return null;
      
      const parsed = JSON.parse(rawValue) as Partial<SessionState>;
      if (typeof parsed.id !== "string" || typeof parsed.lastActivityAt !== "number") {
        return null;
      }
      return { 
        id: parsed.id, 
        lastActivityAt: parsed.lastActivityAt,
        lastBackgroundAt: parsed.lastBackgroundAt 
      };
    } catch {
      return null;
    }
  }

  private save(): void {
    if (!this._state || typeof window === "undefined") return;
    const value = JSON.stringify(this._state);
    try {
      window.localStorage.setItem(this.storageKey("session"), value);
      window.sessionStorage.setItem(this.storageKey("session"), value);
    } catch {
      // Ignore
    }
  }
}
