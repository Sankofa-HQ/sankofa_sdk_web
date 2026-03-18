import { randomId } from "./utils";

export interface SankofaIdentityState {
  distinctId: string;
  anonymousId: string;
  identifiedId: string | null;
}

export class SankofaIdentity {
  private prefix: string;
  private _state: SankofaIdentityState;

  constructor(options: { prefix: string }) {
    this.prefix = options.prefix;
    
    const anonymousId = this.read("anonymous_id") ?? randomId("anon_");
    const identifiedId = this.read("identified_id");
    const distinctId = this.read("current_distinct_id") ?? identifiedId ?? anonymousId;

    this._state = {
      distinctId,
      anonymousId,
      identifiedId,
    };

    this.save();
  }

  get state(): SankofaIdentityState {
    return { ...this._state };
  }

  get distinctId(): string {
    return this._state.distinctId;
  }

  get anonymousId(): string {
    return this._state.anonymousId;
  }

  get identifiedId(): string | null {
    return this._state.identifiedId;
  }

  identify(userId: string): { previous: SankofaIdentityState; current: SankofaIdentityState } {
    const previous = this.state;
    const trimmedId = userId.trim();
    
    if (!trimmedId || previous.distinctId === trimmedId) {
      return { previous, current: previous };
    }

    this._state.identifiedId = trimmedId;
    this._state.distinctId = trimmedId;
    this.save();

    return { previous, current: this.state };
  }

  reset(): { previous: SankofaIdentityState; current: SankofaIdentityState } {
    const previous = this.state;
    const nextAnonymousId = randomId("anon_");

    this._state = {
      anonymousId: nextAnonymousId,
      identifiedId: null,
      distinctId: nextAnonymousId,
    };
    
    this.save();
    return { previous, current: this.state };
  }

  private storageKey(name: string): string {
    return `${this.prefix}:${name}`;
  }

  private read(name: string): string | null {
    try {
      if (typeof window === "undefined") return null;
      return window.localStorage.getItem(this.storageKey(name));
    } catch {
      return null;
    }
  }

  private write(name: string, value: string): void {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(this.storageKey(name), value);
    } catch {
      // Ignore
    }
  }

  private remove(name: string): void {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.removeItem(this.storageKey(name));
    } catch {
      // Ignore
    }
  }

  private save(): void {
    this.write("anonymous_id", this._state.anonymousId);
    this.write("current_distinct_id", this._state.distinctId);
    
    if (this._state.identifiedId) {
      this.write("identified_id", this._state.identifiedId);
    } else {
      this.remove("identified_id");
    }
  }
}
