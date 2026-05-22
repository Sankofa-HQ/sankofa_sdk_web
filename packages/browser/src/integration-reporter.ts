// # Integration health reporter (Web SDK)
//
// Companion to the GET /api/v1/handshake call. After the audit
// resolves, this fires a fire-and-forget POST to
// /api/v1/handshake/integrations so the dashboard's SDK Health page
// reflects this host's wiring state.
//
// Mirrors:
//   - sdks/sankofa_sdk_react_native/src/core/integrationReporter.ts
//   - sdks/sankofa_sdk_flutter/lib/src/core/integration_reporter.dart
// Keep the wire shape identical across SDKs — the server treats every
// payload the same way.
//
// Failure mode: every error is swallowed. The audit result also lives
// in the client's memory, so the next page load re-runs and tries again.

import { SANKOFA_BROWSER_VERSION } from './utils';
import type { ModuleIntegrationStatus } from './integration';

export interface ReportIntegrationParams {
  apiKey: string;
  /** Base URL pointing at the same origin used for /api/v1/handshake. */
  handshakeBaseUrl: URL;
  statuses: ModuleIntegrationStatus[];
  appVersion: string | undefined;
  debug?: boolean;
}

/**
 * POST a batch of module integration statuses to the server. Returns
 * the parsed `{ stored }` count on success, or null on any error.
 */
export async function reportIntegrationStatuses(
  params: ReportIntegrationParams,
): Promise<number | null> {
  if (!params.apiKey || !params.handshakeBaseUrl) return null;
  if (!params.statuses || params.statuses.length === 0) return null;

  // /api/v1/handshake/integrations lives on the same origin/path prefix
  // as the GET handshake — derive by swapping the trailing path segment.
  const url = new URL(params.handshakeBaseUrl.toString());
  url.pathname = url.pathname.replace(/\/?$/, '') + '/integrations';

  const body = {
    sdk: 'web',
    sdk_version: SANKOFA_BROWSER_VERSION,
    platform: 'web',
    app_version: params.appVersion ?? '',
    integrations: params.statuses.map((s) => ({
      module: s.module,
      level: s.level,
      missing: s.missing ?? [],
      warnings: s.warnings ?? [],
    })),
  };

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
      },
      body: JSON.stringify(body),
      // keepalive lets the request survive a page unload — common when
      // the audit fires right before the user navigates away.
      keepalive: true,
    });
    if (!res.ok) {
      if (params.debug) {
        // eslint-disable-next-line no-console
        console.warn(
          `[Sankofa] Integration report rejected (${res.status})`,
        );
      }
      return null;
    }
    const json = (await res.json().catch(() => null)) as { stored?: number } | null;
    if (params.debug) {
      // eslint-disable-next-line no-console
      console.info(
        `[Sankofa] Integration report OK — stored ${json?.stored ?? 0} module status(es)`,
      );
    }
    return json?.stored ?? 0;
  } catch (err) {
    if (params.debug) {
      // eslint-disable-next-line no-console
      console.warn('[Sankofa] Integration report failed:', err);
    }
    return null;
  }
}
