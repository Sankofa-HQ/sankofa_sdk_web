import type { CaptureOptions, Level, UserContext } from './types';

/**
 * Sentry-style temporary scope. Mutations made via the callback in
 * `Sankofa.withScope(fn)` overlay onto the next captured event without
 * polluting the global scope set via `setUser` / `setTags` / `setExtra`.
 *
 * Example:
 * ```ts
 * Sankofa.withScope((scope) => {
 *   scope.setTag('checkout_step', 'payment');
 *   scope.setExtra('cart_id', cart.id);
 *   Sankofa.captureException(err);
 * });
 * // Outside the closure, those tags / extras are gone.
 * ```
 */
export class SankofaScope {
  private _tags: Record<string, string> = {};
  private _extra: Record<string, unknown> = {};
  private _user: UserContext | null = null;
  private _userTouched = false;
  private _level: Level | undefined;
  private _fingerprint: string[] | undefined;

  setTag(key: string, value: string): this {
    this._tags[key] = value;
    return this;
  }

  setTags(tags: Record<string, string>): this {
    this._tags = { ...this._tags, ...tags };
    return this;
  }

  setExtra(key: string, value: unknown): this {
    this._extra[key] = value;
    return this;
  }

  setUser(user: UserContext | null): this {
    this._user = user;
    this._userTouched = true;
    return this;
  }

  setLevel(level: Level): this {
    this._level = level;
    return this;
  }

  setFingerprint(fingerprint: string[]): this {
    this._fingerprint = fingerprint;
    return this;
  }

  /**
   * Project this scope onto a CaptureOptions, layered ON TOP of any
   * options the caller passed to `captureException(err, options)`.
   *
   * Layering order (low → high precedence):
   *   1. global scope (`setTag` etc. on the client)
   *   2. scope (this)
   *   3. caller-supplied `options`
   *
   * The merge here only fills in the SCOPE part; the global layer is
   * applied in `client.capture(...)`. Caller options take precedence
   * because they're the most specific.
   */
  applyTo(options: CaptureOptions): CaptureOptions {
    return {
      level: options.level ?? this._level,
      // Tags merge: scope first, then caller (caller wins on conflict).
      tags: { ...this._tags, ...(options.tags ?? {}) },
      extra: { ...this._extra, ...(options.extra ?? {}) },
      // User: caller wins, then scope. `_userTouched` distinguishes
      // "scope explicitly cleared user with setUser(null)" from "scope
      // never set user" — only the former should override the client's
      // global user.
      user: options.user ?? (this._userTouched ? (this._user ?? undefined) : undefined),
      fingerprint: options.fingerprint ?? this._fingerprint,
      contexts: options.contexts,
    };
  }
}

/**
 * Stack-based scope manager. Each `withScope(fn)` pushes a fresh
 * scope, runs `fn`, then pops — captures happening inside `fn` see
 * the pushed scope at the top of the stack.
 *
 * Async note: a capture deferred past the end of `fn` will NOT see
 * the scope (it's already popped). This matches Sentry's documented
 * behaviour and avoids the AsyncLocalStorage / zone.js dependency
 * the alternative would require. For deferred work, use the explicit
 * `captureException(err, { tags: {...} })` form.
 */
export class ScopeManager {
  private stack: SankofaScope[] = [];

  withScope<T>(fn: (scope: SankofaScope) => T): T {
    const scope = new SankofaScope();
    this.stack.push(scope);
    try {
      return fn(scope);
    } finally {
      this.stack.pop();
    }
  }

  /** Top-of-stack scope, or null when no `withScope` is active. */
  current(): SankofaScope | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }
}
