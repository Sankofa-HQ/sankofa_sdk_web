export type SankofaTransportValue =
  | string
  | number
  | boolean
  | null
  | Date
  | SankofaTransportValue[]
  | { [key: string]: SankofaTransportValue };

export type SankofaPropertyMap = Record<string, SankofaTransportValue | undefined>;

export interface SankofaTrackPayload {
  event_name: string;
  distinct_id: string;
  properties: Record<string, string>;
  default_properties: Record<string, string>;
  timestamp: string;
  lib_version: string;
}

export interface SankofaPeoplePayload {
  distinct_id: string;
  properties: Record<string, string>;
  timestamp: string;
}

export interface SankofaAliasPayload {
  alias_id: string;
  distinct_id: string;
  timestamp: string;
}

export type SankofaBatchOperation =
  | { type: "track"; payload: SankofaTrackPayload }
  | { type: "people"; payload: SankofaPeoplePayload }
  | { type: "alias"; payload: SankofaAliasPayload };

export interface SankofaFlushOptions {
  keepalive?: boolean;
  reason?:
  | "timer"
  | "manual"
  | "pagehide"
  | "visibilitychange"
  | "identify"
  | "reset"
  | "shutdown"
  | "plugin"
  | "buffer";
}

export interface SankofaAutocaptureOptions {
  pageviews?: boolean;
}

export interface SankofaReplayConfig {
  enabled: boolean;
  sample_rate: number;
  high_fidelity_triggers: string[];
  high_fidelity_duration_seconds: number;
  mask_all_inputs: boolean;
  capture_network: boolean;
}

export interface SankofaClientSnapshot {
  apiKey: string;
  batchUrl: string;
  replayChunkUrl: string;
  replayConfigUrl: string;
  /**
   * POST endpoint for Switch exposure batches. Plugins that track
   * per-call flag reads use this to push their dedup'd batches; the
   * server bucket is bounded-channel + drop-on-full so calling this is
   * fire-and-forget from the plugin's perspective.
   */
  switchExposuresUrl: string;
  /**
   * POST endpoint for Sankofa Catch event batches. The Catch plugin
   * reads this at setup time; host apps don't need to plumb the URL
   * manually.
   */
  catchIngestUrl: string;
  distinctId: string;
  anonymousId: string;
  identifiedId: string | null;
  sessionId: string;
  currentScreen: string;
  libVersion: string;
  projectNamespace: string;
}

export interface SankofaPluginContext {
  debug(message: string, ...details: unknown[]): void;
  getSnapshot(): SankofaClientSnapshot;
  touchSession(source?: string): SankofaClientSnapshot;
  replayConfig?: SankofaReplayConfig;
  triggerHighFidelity?(): void;
}

/**
 * Canonical module names Sankofa ships. Plugins that correspond to
 * a first-class module set their `moduleName` so the Traffic Cop can
 * route handshake flags to them.
 */
export type SankofaModuleName =
  | "analytics"
  | "deploy"
  | "catch"
  | "switch"
  | "config";

export interface SankofaPluginInstance {
  flush?(options?: SankofaFlushOptions): Promise<void> | void;
  shutdown?(): Promise<void> | void;
  onDistinctIdChange?(
    current: SankofaClientSnapshot,
    previous: SankofaClientSnapshot,
  ): Promise<void> | void;
  onSessionChange?(
    current: SankofaClientSnapshot,
    previous: SankofaClientSnapshot,
  ): Promise<void> | void;
  onHighFidelity?(): Promise<void> | void;
  /**
   * Traffic Cop hook — called when the handshake response says this
   * plugin's module is enabled. Only invoked on plugins that declared
   * a `moduleName`. Missing plugins (not in `plugins` array) get a
   * dev-mode warning and a silent no-op in production.
   */
  applyHandshake?(config: Record<string, unknown>): Promise<void> | void;
}

export interface SankofaPlugin {
  name: string;
  /**
   * If set, identifies this plugin as the handler for a canonical
   * Sankofa module (deploy, catch, ...). The Core will route the
   * corresponding handshake flag to this plugin via `applyHandshake`.
   */
  moduleName?: SankofaModuleName;
  setup(
    context: SankofaPluginContext,
  ): Promise<SankofaPluginInstance | void> | SankofaPluginInstance | void;
}

export interface SankofaInitOptions {
  apiKey: string;
  endpoint: string;
  debug?: boolean;
  flushIntervalMs?: number;
  autocapture?: boolean | SankofaAutocaptureOptions;
  plugins?: SankofaPlugin[];
}

export interface QueuedRecord<T> {
  id: number;
  value: T;
}

export interface PersistentQueue<T> {
  add(value: T): Promise<number>;
  getAll(limit?: number): Promise<Array<QueuedRecord<T>>>;
  deleteMany(ids: number[]): Promise<void>;
  count(): Promise<number>;
}
