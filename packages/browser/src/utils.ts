import type { SankofaPropertyMap, SankofaTransportValue } from "./types";

export const SANKOFA_BROWSER_VERSION = "browser-0.1.0";
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export function resolveV1BaseUrl(endpoint: string): URL {
  const url = new URL(endpoint.trim());
  const segments = trimPathSegments(url.pathname);

  if (endsWithSegments(segments, ["api", "v1", "track"])) {
    url.pathname = toPathname(segments.slice(0, -1));
    return url;
  }

  if (endsWithSegments(segments, ["api", "v1", "batch"])) {
    url.pathname = toPathname(segments.slice(0, -1));
    return url;
  }

  if (endsWithSegments(segments, ["api", "v1"])) {
    url.pathname = toPathname(segments);
    return url;
  }

  if (endsWithSegments(segments, ["v1", "track"]) || endsWithSegments(segments, ["v1", "batch"])) {
    url.pathname = toPathname([...segments.slice(0, -2), "api", "v1"]);
    return url;
  }

  if (endsWithSegments(segments, ["v1"])) {
    url.pathname = toPathname([...segments.slice(0, -1), "api", "v1"]);
    return url;
  }

  url.pathname = toPathname([...segments, "api", "v1"]);
  return url;
}

export function resolveServerBaseUrl(endpoint: string): URL {
  const v1Base = resolveV1BaseUrl(endpoint);
  const segments = trimPathSegments(v1Base.pathname);

  if (endsWithSegments(segments, ["api", "v1"])) {
    v1Base.pathname = toPathname(segments.slice(0, -2));
  }

  return v1Base;
}

export function resolveTrackUrl(endpoint: string): URL {
  const url = resolveV1BaseUrl(endpoint);
  url.pathname = toPathname([...trimPathSegments(url.pathname), "track"]);
  return url;
}

export function resolveBatchUrl(endpoint: string): URL {
  const url = resolveV1BaseUrl(endpoint);
  url.pathname = toPathname([...trimPathSegments(url.pathname), "batch"]);
  return url;
}

export function resolveReplayChunkUrl(endpoint: string): URL {
  const url = resolveServerBaseUrl(endpoint);
  url.pathname = toPathname([...trimPathSegments(url.pathname), "api", "replay", "chunk"]);
  return url;
}

export function resolveReplayConfigUrl(endpoint: string): URL {
  const url = resolveServerBaseUrl(endpoint);
  url.pathname = toPathname([...trimPathSegments(url.pathname), "api", "replay", "config"]);
  return url;
}

export function resolveHandshakeUrl(endpoint: string): URL {
  const url = resolveServerBaseUrl(endpoint);
  url.pathname = toPathname([...trimPathSegments(url.pathname), "api", "v1", "handshake"]);
  return url;
}

/**
 * Exposure ingest URL: POST /api/switch/exposures. Lives on the
 * public (non-v1) Switch ingest group alongside the halt-webhook so
 * the bounded rate limiter applies and CORS is permissive enough for
 * browsers on arbitrary origins.
 */
export function resolveSwitchExposuresUrl(endpoint: string): URL {
  const url = resolveServerBaseUrl(endpoint);
  url.pathname = toPathname([...trimPathSegments(url.pathname), "api", "switch", "exposures"]);
  return url;
}

/**
 * Catch event ingest URL: POST /api/catch/events. Public, rate-
 * limited, x-api-key-authenticated endpoint that accepts batched
 * CatchEventV1 payloads. The Catch plugin reads this URL from the
 * client snapshot at setup time — no explicit endpoint option
 * required.
 */
export function resolveCatchIngestUrl(endpoint: string): URL {
  const url = resolveServerBaseUrl(endpoint);
  url.pathname = toPathname([...trimPathSegments(url.pathname), "api", "catch", "events"]);
  return url;
}

export function serializeTransportProperties(
  properties: SankofaPropertyMap,
): Record<string, string> {
  const serialized: Record<string, string> = {};

  Object.entries(properties).forEach(([key, value]) => {
    if (typeof value === "undefined") {
      return;
    }

    serialized[key] = serializeTransportValue(value);
  });

  return serialized;
}

export function serializeTransportValue(value: SankofaTransportValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value.map(toEncodableJson));
  }

  return JSON.stringify(toEncodableJson(value));
}

export function randomId(prefix?: string): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}${id}` : id;
}

export function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function toEncodableJson(value: SankofaTransportValue): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(toEncodableJson);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      typeof nestedValue === "undefined" ? null : toEncodableJson(nestedValue),
    ]),
  );
}

function trimPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function toPathname(segments: string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function endsWithSegments(actual: string[], suffix: string[]): boolean {
  if (actual.length < suffix.length) {
    return false;
  }

  for (let index = 0; index < suffix.length; index += 1) {
    if (actual[actual.length - suffix.length + index] !== suffix[index]) {
      return false;
    }
  }

  return true;
}
