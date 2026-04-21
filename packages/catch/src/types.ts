// Sankofa Catch wire contract — TypeScript mirror of
// server/engine/ee/catch/wire.go. These types are load-bearing:
// renaming any field in this file without the server rename IS a
// breaking change. The server rejects events with unknown field names
// in wire_version 1.
//
// Additions allowed as new optional fields. Renames / type changes
// require bumping to V2 with server-side co-existence.

export const WireVersionCurrent = 1 as const;

export type Level = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export type EventType =
  | 'unhandled_exception'
  | 'unhandled_rejection'
  | 'console_error'
  | 'handled'
  | 'anr'
  | 'oom'
  | 'native_crash'
  | (string & {});

export type Platform =
  | 'javascript'
  | 'react-native'
  | 'ios'
  | 'android'
  | 'flutter'
  | 'node'
  | 'go'
  | 'python'
  | 'java';

export interface SDKInfo {
  name: string;
  version: string;
}

export interface Mechanism {
  type: string;
  handled: boolean;
  description?: string;
}

export interface StackFrame {
  filename?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  abs_path?: string;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
  in_app?: boolean;
  vars?: Record<string, unknown>;
  platform?: string;
  instruction_addr?: string;
  package?: string;
  symbol?: string;
  symbol_addr?: string;
  /**
   * ASLR address mode. Empty or "abs" means absolute; "rel:N" means
   * relative to `debug_meta.images[N].image_addr`.
   */
  addr_mode?: string;
}

export interface StackTrace {
  frames: StackFrame[];
}

export interface Exception {
  type: string;
  value: string;
  module?: string;
  mechanism?: Mechanism;
  stacktrace?: StackTrace;
  chained?: Exception[];
}

export interface UserContext {
  id?: string;
  email?: string;
  username?: string;
  ip_address?: string;
  segment?: string;
  data?: Record<string, string>;
}

export interface DeviceContext {
  os?: string;
  os_version?: string;
  browser?: string;
  browser_version?: string;
  model?: string;
  arch?: string;
  memory_mb?: number;
  screen?: string;
  locale?: string;
  country?: string;
  timezone?: string;
  app_version?: string;
  online?: boolean;
}

export interface RequestContext {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  query_string?: string;
  data?: unknown;
  cookies?: Record<string, string>;
  env?: Record<string, string>;
}

export type BreadcrumbType =
  | 'default'
  | 'http'
  | 'navigation'
  | 'ui.click'
  | 'info'
  | 'warning'
  | 'error'
  | 'query'
  | 'console'
  | (string & {});

export interface Breadcrumb {
  ts_ms: number;
  type: BreadcrumbType;
  category?: string;
  message?: string;
  level?: Level;
  data?: Record<string, unknown>;
}

export interface DebugImage {
  type: 'macho' | 'elf' | 'pe' | 'wasm' | 'proguard' | 'sourcemap';
  debug_id: string;
  code_id?: string;
  code_file?: string;
  debug_file?: string;
  image_addr: string;
  image_size?: number;
  image_vmaddr?: string;
  arch?: string;
}

export interface DebugSDKInfo {
  sdk_name?: string;
  version_major?: number;
  version_minor?: number;
  version_patchlevel?: number;
}

export interface DebugMeta {
  images?: DebugImage[];
  sdk_info?: DebugSDKInfo;
}

/**
 * The full event envelope exactly as sent on the wire. Field names
 * MUST match wire.go 1:1; the server rejects unknown fields under
 * wire_version 1.
 */
export interface CatchEvent {
  wire_version: typeof WireVersionCurrent;
  event_id: string;
  ts_ms: number;
  received_at_ms?: number;
  environment: 'live' | 'test';
  project_id?: string;

  distinct_id?: string;
  anon_id?: string;
  session_id?: string;

  level: Level;
  type: EventType;

  exception?: Exception;
  message?: string;

  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: UserContext;
  device?: DeviceContext;
  request?: RequestContext;
  release?: string;
  server_name?: string;
  platform: Platform;
  sdk: SDKInfo;

  breadcrumbs?: Breadcrumb[];
  fingerprint?: string[];

  flag_snapshot?: Record<string, string>;
  config_snapshot?: Record<string, unknown>;
  trace_id?: string;
  span_id?: string;
  replay_chunk_index?: number;

  debug_meta?: DebugMeta;
}

export interface CatchBatch {
  wire_version: typeof WireVersionCurrent;
  events: CatchEvent[];
}

// ─── Handshake config (read from modules.catch) ─────────────────────

export interface CatchHandshakeConfig {
  enabled?: boolean;
  wire_version?: number;
  ingest_url?: string;
  sampling?: {
    error_sample_rate?: number;
    transaction_sample_rate?: number;
    profiles_sample_rate?: number;
  };
  replay?: {
    on_error_enabled?: boolean;
    burst_seconds?: number;
  };
  breadcrumbs?: {
    max_buffer?: number;
  };
  reason?: string;
  error?: string;
}

// ─── Public client API surface ──────────────────────────────────────

export interface CaptureOptions {
  level?: Level;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: UserContext;
  fingerprint?: string[];
  contexts?: {
    trace?: { trace_id: string; span_id?: string };
  };
}

export interface SankofaCatchAPI {
  /** Capture an Error instance. */
  captureException(err: unknown, options?: CaptureOptions): string;
  /** Capture a plain string (console.error-style). */
  captureMessage(message: string, options?: CaptureOptions): string;
  /** Add a breadcrumb to the ring buffer. */
  addBreadcrumb(crumb: Omit<Breadcrumb, 'ts_ms'> & { ts_ms?: number }): void;
  /** Merge user context into every subsequent event. */
  setUser(user: UserContext | null): void;
  /** Merge tags into every subsequent event. */
  setTags(tags: Record<string, string>): void;
  /** Attach extra context to every subsequent event. */
  setExtra(key: string, value: unknown): void;
  /** Force-flush the transport. Promise resolves when the batch is POSTed. */
  flush(): Promise<void>;
}

// ── M7: Performance wire types ───────────────────────────────────────

export type VitalMetric = 'lcp' | 'fid' | 'cls' | 'inp' | 'ttfb' | 'fcp' | 'fp';
export type VitalRating = 'good' | 'needs-improvement' | 'poor';

export interface WebVitalWire {
  wire_version: typeof WireVersionCurrent;
  event_id: string;
  environment: 'live' | 'test';
  distinct_id?: string;
  anon_id?: string;
  session_id?: string;
  release?: string;
  platform: Platform;
  sdk: SDKInfo;
  metric: VitalMetric;
  value: number;
  rating?: VitalRating;
  id?: string;
  url?: string;
  navigation?: 'navigate' | 'reload' | 'back-forward' | 'prerender';
  ts_ms: number;
  device?: DeviceContext;
  tags?: Record<string, string>;
}

export interface VitalsBatch {
  wire_version: typeof WireVersionCurrent;
  vitals: WebVitalWire[];
}

export type SpanStatus =
  | 'ok'
  | 'cancelled'
  | 'internal_error'
  | 'not_found'
  | 'unauthenticated'
  | 'permission_denied'
  | 'failed_precondition'
  | (string & {});

export interface SpanWire {
  span_id: string;
  parent_span_id?: string;
  op: string;
  description?: string;
  start_ms: number;
  end_ms: number;
  status?: SpanStatus;
  tags?: Record<string, string>;
  data?: Record<string, unknown>;
}

export interface TransactionWire {
  wire_version: typeof WireVersionCurrent;
  event_id: string;
  environment: 'live' | 'test';
  distinct_id?: string;
  anon_id?: string;
  session_id?: string;
  release?: string;
  server_name?: string;
  platform: Platform;
  sdk: SDKInfo;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  op: string;
  start_ms: number;
  end_ms: number;
  status?: SpanStatus;
  http_status?: number;
  sample_rate?: number;
  tags?: Record<string, string>;
  data?: Record<string, unknown>;
  user?: UserContext;
  device?: DeviceContext;
  request?: RequestContext;
  spans?: SpanWire[];
}

export interface TransactionBatch {
  wire_version: typeof WireVersionCurrent;
  transactions: TransactionWire[];
}
