import { BreadcrumbsAutocapture, BreadcrumbsBuffer } from './breadcrumbs';
import { errorToException } from './stack-parser';
import { Transport } from './transport';
import type {
  Breadcrumb,
  CaptureOptions,
  CatchEvent,
  CatchHandshakeConfig,
  DeviceContext,
  Level,
  SankofaCatchAPI,
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

  setUser(user: UserContext | null): void {
    this.user = user;
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
    options: CaptureOptions,
    /* future-proofing hook */ sampled: boolean,
    mechanism: { mechanismType?: string; handled?: boolean } = {},
  ): string {
    if (!this.enabled) return '';
    if (!sampled || !this.shouldSample()) return '';

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

      flag_snapshot: this.readFlagSnapshot?.(),
      config_snapshot: this.readConfigSnapshot?.(),
      trace_id: options.contexts?.trace?.trace_id,
      span_id: options.contexts?.trace?.span_id,
    };

    this.transport.push(event);
    return eventId;
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
