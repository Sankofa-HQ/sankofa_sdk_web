import { SESSION_TIMEOUT_MS, randomId } from "./utils";

export interface SessionState {
  id: string;
  lastActivityAt: number;
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

  refresh(): { previous: SessionState | null; current: SessionState } {
    const previous = this._state ? { ...this._state } : null;
    const now = Date.now();
    const stored = this.read();

    if (!stored || now - stored.lastActivityAt > SESSION_TIMEOUT_MS) {
      this._state = this.startNewSession();
    } else {
      this._state = {
        ...stored,
        lastActivityAt: now,
      };
      this.save();
    }

    return { previous, current: this.state };
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
      return { id: parsed.id, lastActivityAt: parsed.lastActivityAt };
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
