/**
 * Cross-module API registry.
 *
 * Each Sankofa plugin (switch, config, catch, ...) registers its
 * public-facing instance under a canonical module name when its
 * `setup()` runs. Other plugins read from the registry to introspect
 * sibling modules without taking a hard dependency on each other —
 * @sankofa/catch must not pull @sankofa/switch into the host bundle
 * just so a crash report can include a flag snapshot.
 *
 * The map keys are the same `SankofaModuleName` literals used by the
 * Traffic Cop (handshake routing) so a single source of truth covers
 * both directions: server-to-plugin (Traffic Cop) and plugin-to-plugin
 * (this registry).
 *
 * Lifecycle:
 *   - `registerModuleAPI('switch', singleton)` is called inside
 *     `switchPlugin().setup(...)`. Subsequent calls overwrite — the
 *     last setup wins, which is what we want for hot-reload + re-init.
 *   - `unregisterModuleAPI('switch')` clears the slot on plugin
 *     `shutdown()` so a stale singleton can't leak across re-inits.
 *   - `getModuleAPI('switch')` returns the registered instance or null.
 *     Callers cast to the concrete API type — the registry is
 *     intentionally untyped here because @sankofa/browser cannot
 *     import the optional packages' types.
 */

import type { SankofaModuleName } from './types';

const registry: Map<SankofaModuleName, unknown> = new Map();

export function registerModuleAPI(name: SankofaModuleName, api: unknown): void {
  registry.set(name, api);
}

export function unregisterModuleAPI(name: SankofaModuleName): void {
  registry.delete(name);
}

export function getModuleAPI<T = unknown>(name: SankofaModuleName): T | null {
  const value = registry.get(name);
  return (value ?? null) as T | null;
}
