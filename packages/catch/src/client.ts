import { BreadcrumbsAutocapture, BreadcrumbsBuffer } from './breadcrumbs';
import { ScopeManager, type SankofaScope } from './scope';
import { errorToException } from './stack-parser';
import { Transport } from './transport';
import type {
  BeforeSendFn,
  Breadcrumb,
  CaptureOptions,
  CatchEvent,
  CatchHandshakeConfig,
  DeviceContext,
  Level,
  SankofaCatchAPI,
  SankofaCatchScope,
  UserContext,
} from './types';
import { WireVersionCurrent } from './types';

/**
 * SankofaCatchClient — the in-process client that collects context,
 * composes CatchEvents, and hands them to the Transport for delivery.
 *
 * Created once per Sankofa.init() via the catchPlugin factory. Not
 * meant to be constructed directly by host apps — they use
 * `getCatch()` to access the singleton.
 */

type SnapshotFn = () => {
  distinctId?: string;
  anonymousId?: string;
  sessionId?: string;
  libVersion: string;
  /**
   * Active screen / route at capture time. Set by the host via
   * `client.screen('Identify')` (web) or React Navigation auto-track
   * (RN). When absent, the Catch client falls back to
   * `window.location.pathname` so cross-product correlation with
   * Heatmap / Replay / Pulse still works for hosts that haven't wired
   * an explicit screen tracker yet.
   */
  currentScreen?: string;
};

type FlagSnapshotFn = () => Record<string, string> | undefined;
type ConfigSnapshotFn = () => Record<string, unknown> | undefined;
type ReplayTriggerFn = () => void;

export interface CatchClientOptions {
  transport: Transport;
  buffer: BreadcrumbsBuffer;
  autocapture: BreadcrumbsAutocapture;
  snapshot: SnapshotFn;
  environment: 'live' | 'test';
  release?: string;
  appVersion?: string;
  debug?: (msg: string, ...rest: unknown[]) => void;
  /** Called to request a high-fidelity replay burst on uncaught errors. */
  triggerReplay?: ReplayTriggerFn;
  /** Called to read the current flag decisions at event capture time. */
  readFlagSnapshot?: FlagSnapshotFn;
  /** Called to read the current config values at event capture time. */
  readConfigSnapshot?: ConfigSnapshotFn;
  /**
   * Synchronous hook fired AFTER event composition but BEFORE the
   * transport sends. Return `null` to drop the event, return the
   * (possibly modified) event to ship it. Throws are swallowed —
   * a host hook can never block the capture pipeline.
   */
  beforeSend?: BeforeSendFn;
}

export class SankofaCatchClient implements SankofaCatchAPI {
  private readonly transport: Transport;
  private readonly buffer: BreadcrumbsBuffer;
  private readonly autocapture: BreadcrumbsAutocapture;
  private readonly snapshot: SnapshotFn;
  private readonly environment: 'live' | 'test';
  private readonly release?: string;
  private readonly appVersion?: string;
  private readonly debug: (msg: string, ...rest: unknown[]) => void;
  private readonly triggerReplay?: ReplayTriggerFn;
  private readonly readFlagSnapshot?: FlagSnapshotFn;
  private readonly readConfigSnapshot?: ConfigSnapshotFn;
  private readonly beforeSend?: BeforeSendFn;
  private readonly scopeManager = new ScopeManager();

  // Scope — sticky context merged into every outgoing event.
  private user: UserContext | null = null;
  private tags: Record<string, string> = {};
  private extra: Record<string, unknown> = {};

  // Handshake-driven sampling. 1.0 means "every error"; 0.1 means
  // "10%". Mutations / identity changes flip this via setSampleRate.
  private errorSampleRate = 1.0;
  private enabled = true;

  constructor(opts: CatchClientOptions) {
    this.transport = opts.transport;
    this.buffer = opts.buffer;
    this.autocapture = opts.autocapture;
    this.snapshot = opts.snapshot;
    this.environment = opts.environment;
    this.release = opts.release;
    this.appVersion = opts.appVersion;
    this.debug = opts.debug ?? (() => {});
    this.triggerReplay = opts.triggerReplay;
    this.readFlagSnapshot = opts.readFlagSnapshot;
    this.readConfigSnapshot = opts.readConfigSnapshot;
    this.beforeSend = opts.beforeSend;
  }

  /**
   * Run `fn` with a fresh scope pushed onto the manager's stack. Any
   * `captureException` / `captureMessage` calls inside `fn` see the
   * scope merged in (between global state and caller `options`).
   */
  withScope<T>(fn: (scope: SankofaCatchScope) => T): T {
    return this.scopeManager.withScope(fn);
  }

  applyHandshake(cfg: CatchHandshakeConfig | undefined): void {
    if (!cfg) return;
    if (cfg.enabled === false) {
      this.enabled = false;
      this.debug(`catch disabled by handshake: ${cfg.reason ?? 'unknown'}`);
      return;
    }
    this.enabled = true;
    if (cfg.sampling?.error_sample_rate !== undefined) {
      this.errorSampleRate = Math.max(0, Math.min(1, cfg.sampling.error_sample_rate));
    }
    if (cfg.breadcrumbs?.max_buffer !== undefined) {
      this.buffer.setCapacity(cfg.breadcrumbs.max_buffer);
    }
  }

  // ── Public API — SankofaCatchAPI ─────────────────────────────────

  captureException(err: unknown, options: CaptureOptions = {}): string {
    return this.capture(err, 'unhandled_exception', options, /*sampled=*/ true);
  }

  captureMessage(message: string, options: CaptureOptions = {}): string {
    return this.capture(message, 'console_error', options, /*sampled=*/ true);
  }

  addBreadcrumb(crumb: Omit<Breadcrumb, 'ts_ms'> & { ts_ms?: number }): void {
    this.buffer.push(crumb);
  }

  log(message: string, category?: string): void {
    this.buffer.push({
      type: 'log',
      category: category ?? 'log',
      message,
      level: 'info',
    });
  }

  setUser(user: UserContext | null): void {
    this.user = user;
  }

  setTag(key: string, value: string): void {
    this.tags = { ...this.tags, [key]: value };
  }

  setTags(tags: Record<string, string>): void {
    this.tags = { ...this.tags, ...tags };
  }

  setExtra(key: string, value: unknown): void {
    this.extra[key] = value;
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  // ── Internal surface used by global handlers ─────────────────────

  /**
   * Capture a raw error fired by the global handlers. Lets the
   * handler pick the wire `type` + the mechanism, which differs
   * between uncaught exceptions and unhandled rejections.
   */
  captureRaw(
    err: unknown,
    params: {
      type: CatchEvent['type'];
      mechanismType: string;
      handled: boolean;
      options?: CaptureOptions;
    },
  ): string {
    return this.capture(err, params.type, params.options ?? {}, /*sampled=*/ true, {
      mechanismType: params.mechanismType,
      handled: params.handled,
    });
  }

  // ── Event composition ────────────────────────────────────────────

  private capture(
    errOrMessage: unknown,
    type: CatchEvent['type'],
    optionsIn: CaptureOptions,
    /* future-proofing hook */ sampled: boolean,
    mechanism: { mechanismType?: string; handled?: boolean } = {},
  ): string {
    if (!this.enabled) return '';
    if (!sampled || !this.shouldSample()) return '';

    // Apply active withScope() overlay (if any). Layering order:
    //   global setUser/setTags/setExtra (read below)
    //   → scope (applyTo here)
    //   → caller-supplied options (already merged in by applyTo)
    const scope = this.scopeManager.current();
    const options: CaptureOptions = scope ? scope.applyTo(optionsIn) : optionsIn;

    const isUnhandled = mechanism.handled === false;
    if (isUnhandled && this.triggerReplay) {
      // Kick the replay layer into high-fidelity burst BEFORE the
      // event leaves. The burst is asynchronous; the replay chunk
      // correlation happens server-side via session_id + timestamp.
      try {
        this.triggerReplay();
      } catch {
        /* replay is best-effort */
      }
    }

    const now = Date.now();
    const snap = this.snapshot();
    const level: Level = options.level ?? (type === 'console_error' ? 'warning' : 'error');

    // Compose the Exception shape for thrown values; keep string-
    // style messages as top-level `message`.
    let exception: CatchEvent['exception'];
    let message: string | undefined;
    if (typeof errOrMessage === 'string') {
      message = errOrMessage;
    } else {
      exception = errorToException(errOrMessage, {
        type: mechanism.mechanismType ?? 'manual',
        handled: mechanism.handled ?? true,
      });
    }

    const eventId = randomId();
    const event: CatchEvent = {
      wire_version: WireVersionCurrent,
      event_id: eventId,
      ts_ms: now,
      environment: this.environment,

      distinct_id: snap.distinctId,
      anon_id:
        snap.anonymousId && snap.anonymousId !== snap.distinctId ? snap.anonymousId : undefined,
      session_id: snap.sessionId,

      level,
      type,

      exception,
      message,

      tags: { ...this.tags, ...(options.tags ?? {}) },
      extra: { ...this.extra, ...(options.extra ?? {}) },
      user: options.user ?? this.user ?? undefined,
      device: this.buildDeviceContext(),
      release: this.release,
      platform: 'javascript',
      sdk: {
        name: 'sankofa.web',
        version: snap.libVersion,
      },

      breadcrumbs: this.buffer.snapshot(),
      fingerprint: options.fingerprint,

      screen: snap.currentScreen || autoDetectScreen(),

      flag_snapshot: this.readFlagSnapshot?.(),
      config_snapshot: this.readConfigSnapshot?.(),
      trace_id: options.contexts?.trace?.trace_id,
      span_id: options.contexts?.trace?.span_id,
    };

    // beforeSend hook — host gets final say. A null return drops the
    // event; an exception is treated as "pass through unchanged"
    // because losing telemetry from a buggy hook is worse than the
    // hook misbehaving.
    let outgoing: CatchEvent | null = event;
    if (this.beforeSend) {
      try {
        outgoing = this.beforeSend(event);
      } catch (err) {
        this.debug('beforeSend threw — sending original event', err);
        outgoing = event;
      }
    }
    if (!outgoing) {
      this.debug(`event ${event.event_id} dropped by beforeSend`);
      return '';
    }
    this.transport.push(outgoing);
    return outgoing.event_id;
  }

  private shouldSample(): boolean {
    if (this.errorSampleRate >= 1) return true;
    if (this.errorSampleRate <= 0) return false;
    return Math.random() < this.errorSampleRate;
  }

  private buildDeviceContext(): DeviceContext | undefined {
    if (typeof navigator === 'undefined') return undefined;
    const ua = navigator.userAgent ?? '';
    let os = 'Other';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac/i.test(ua)) os = 'macOS';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Linux/i.test(ua)) os = 'Linux';

    let browser = 'Other';
    let browserVer: string | undefined;
    const chrome = /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua);
    const safari = /Version\/([\d.]+).*Safari/.exec(ua);
    const firefox = /Firefox\/([\d.]+)/.exec(ua);
    const edge = /Edg\/([\d.]+)/.exec(ua);
    if (edge) {
      browser = 'Edge';
      browserVer = edge[1];
    } else if (chrome) {
      browser = 'Chrome';
      browserVer = chrome[1];
    } else if (firefox) {
      browser = 'Firefox';
      browserVer = firefox[1];
    } else if (safari) {
      browser = 'Safari';
      browserVer = safari[1];
    }

    return {
      os,
      browser,
      browser_version: browserVer,
      locale: navigator.language,
      timezone:
        typeof Intl !== 'undefined' && Intl.DateTimeFormat
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined,
      online: typeof navigator.onLine === 'boolean' ? navigator.onLine : undefined,
      app_version: this.appVersion,
      screen:
        typeof window !== 'undefined' && window.screen
          ? `${window.screen.width}x${window.screen.height}`
          : undefined,
    };
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function autoDetectScreen(): string | undefined {
  // Fallback when the host hasn't called `client.screen(name)`. Prefers
  // `location.pathname` over `document.title` because the path is
  // stable and matches the convention Heatmap / Replay use to scope by
  // screen. Returns undefined in non-browser contexts (e.g. node tests)
  // so the wire field stays absent rather than carrying a misleading
  // value.
  if (typeof window === 'undefined' || !window.location) return undefined;
  const path = window.location.pathname;
  return path && path !== '' ? path : undefined;
}
