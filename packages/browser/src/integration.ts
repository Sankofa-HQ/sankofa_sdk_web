// # Module integration self-audit (Web SDK)
//
// Mirrors the `ModuleIntegrationStatus` type used by the Flutter + RN
// SDKs. Reported to the server via `POST /api/v1/handshake/integrations`
// so the dashboard's SDK Health page can flag silently-broken host
// integrations (wrong endpoint, missing app_version, mixed-content, …).
//
// Keep the wire shape in lockstep with:
//   - sdks/sankofa_sdk_react_native/src/core/integration.ts
//   - sdks/sankofa_sdk_flutter/lib/src/core/module_registry.dart
//   - server/engine/ee/deploy/integration_health.go

export type ModuleIntegrationLevel = 'full' | 'partial' | 'broken';

export interface ModuleIntegrationStatus {
  module: string;
  level: ModuleIntegrationLevel;
  missing: string[];
  warnings: string[];
}

/** Derive the level from missing-count, matching RN + Flutter rule. */
export function deriveIntegrationLevel(missing: string[]): ModuleIntegrationLevel {
  if (missing.length === 0) return 'full';
  if (missing.length >= 2) return 'broken';
  return 'partial';
}

export interface WebAuditInputs {
  /** True iff the GET /api/v1/handshake call returned non-null modules. */
  handshakeOk: boolean;
  /** Whether the host explicitly set appVersion via `init({ appVersion })`. */
  appVersionFromHost: boolean;
}

/**
 * Audit the host's Web SDK integration. Runs synchronously after init
 * resolves — every check probes a browser API or a state flag the
 * client already has in scope.
 */
export function auditWebIntegration(inputs: WebAuditInputs): ModuleIntegrationStatus {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Hard breakage: server is unreachable or rejected the API key. The
  // host's analytics will fall back to the cached handshake but new
  // capabilities never light up.
  if (!inputs.handshakeOk) {
    missing.push(
      'Handshake to /api/v1/handshake did not succeed. Check the endpoint URL and that the API key is valid.',
    );
  }

  // Hard breakage on legacy browsers that haven't shipped fetch — the
  // SDK uses fetch for every network call so without it nothing works.
  if (typeof fetch !== 'function') {
    missing.push(
      'Global `fetch` is not available. The Sankofa Web SDK requires it; load a polyfill or upgrade to a modern browser build.',
    );
  }

  // Soft breakage: localStorage backs identity + handshake cache. In
  // private-window or storage-disabled contexts the SDK still works
  // for one-shot pageviews but identity stitching and 304 re-use fall
  // off. Worth flagging without claiming the integration is broken.
  let localStorageOk = false;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const probeKey = '__sankofa_audit_probe__';
      window.localStorage.setItem(probeKey, '1');
      window.localStorage.removeItem(probeKey);
      localStorageOk = true;
    }
  } catch {
    localStorageOk = false;
  }
  if (!localStorageOk) {
    warnings.push(
      'localStorage is not writable — identity stitching and handshake cache will be limited.',
    );
  }

  // HTTPS warning. Mixed-content blocking will silently drop POSTs in
  // most browsers when the page is HTTPS and the endpoint is HTTP — and
  // vice-versa. We only check the host page; the endpoint check happens
  // at fetch time.
  if (typeof window !== 'undefined') {
    const proto = window.location?.protocol ?? '';
    const host = window.location?.hostname ?? '';
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    if (proto === 'http:' && !isLocal) {
      warnings.push(
        'Page is served over HTTP (not localhost). Browsers may block analytics requests to HTTPS endpoints under mixed-content rules.',
      );
    }
  }

  // App version warning. Without an explicit app_version the server
  // bucket apps under the SDK's own version, which is almost never
  // what release-rollout / cohort rules expect.
  if (!inputs.appVersionFromHost) {
    warnings.push(
      'init({ appVersion }) not set — server is using the SDK library version as a fallback. Release-rollout and version cohorts will misclassify this host.',
    );
  }

  return {
    module: 'analytics',
    level: deriveIntegrationLevel(missing),
    missing,
    warnings,
  };
}
