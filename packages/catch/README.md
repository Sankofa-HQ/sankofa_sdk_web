# @sankofa/catch

Error tracking, breadcrumbs, performance vitals, and source-mapped stack traces for the web. Crashlytics + Sentry merged.

## Installation

```bash
npm install @sankofa/browser @sankofa/catch
```

## Quick Start

```ts
import { Sankofa } from '@sankofa/browser';
import { catchPlugin } from '@sankofa/catch';

Sankofa.init({
  apiKey: 'YOUR_PROJECT_API_KEY',
  endpoint: 'https://api.sankofa.dev',
  plugins: [
    catchPlugin({
      release: process.env.GIT_SHA,  // critical for source-map matching
      environment: 'production',

      // Sentry-style hook fired AFTER event composition but BEFORE
      // the transport sends. Return null to drop entirely; return
      // the (possibly modified) event to ship. Throws swallowed.
      beforeSend: (event) => {
        if (event.message?.includes('ResizeObserver loop limit')) return null;
        if (event.user?.email) {
          return { ...event, user: { ...event.user, email: undefined } };
        }
        return event;
      },
    }),
  ],
});

// Capture from anywhere — Sentry-style statics on the Sankofa namespace.
try {
  await chargeCard(amount);
} catch (err) {
  Sankofa.captureException(err);
}

// Crashlytics-style breadcrumb log — rides on next capture, doesn't bill.
Sankofa.log('checkout: applying coupon SUMMER25');

// Sentry-style temporary scope
Sankofa.withScope((scope) => {
  scope.setTag('checkout_step', 'payment');
  scope.setExtra('cart_id', cart.id);
  scope.setLevel('warning');
  Sankofa.captureException(err);
});
```

## Automatic coverage

Once `catchPlugin()` is registered, every error path below routes to Catch with no further wiring:

| Source | Behavior |
|---|---|
| `window.onerror` | Captures, fingerprints, uploads. |
| `unhandledrejection` | Same. |
| `console.error` | Becomes a breadcrumb (not a billed event). |
| Failed `fetch` / `XHR` | 4xx + 5xx responses become breadcrumbs. |
| Page navigations | `$pageview` events become breadcrumbs. |
| `Sankofa.track(...)` | Becomes a breadcrumb on the next captured event. |
| Web Vitals (LCP/CLS/FCP/INP/TTFB) | POSTed to the perf transport. |
| Pageload transaction | One per navigation, summarising the timeline. |

## Auto-discovered flag + config snapshots

If you also register `@sankofa/switch` / `@sankofa/config`, every captured event carries a `flag_snapshot` + `config_snapshot` of the active decisions. The dashboard shows "which flags were ON when this error fired" with no host wiring.

```ts
import { switchPlugin } from '@sankofa/switch';
import { configPlugin } from '@sankofa/config';

Sankofa.init({
  plugins: [
    switchPlugin({ defaults: { new_checkout: false } }),
    configPlugin({ defaults: { max_uploads_per_day: 25 } }),
    catchPlugin({ /* ... */ }),  // auto-discovers the above
  ],
});
```

## Source maps

```bash
npx sankofa-cli catch symbols upload \
  --kind js_sourcemap \
  --release "$GIT_SHA" \
  --dir ./dist
```

## API

| Symbol | Description |
|---|---|
| `catchPlugin(options?)` | Plugin to register at `Sankofa.init`. |
| `getCatch()` | Returns the singleton catch client (rarely needed — prefer the `Sankofa.*` statics). |
| `Sankofa.captureException(err, options?)` | Capture an error. Returns event ID. |
| `Sankofa.captureMessage(msg, options?)` | Capture a non-error event. |
| `Sankofa.log(msg, category?)` | Crashlytics-style breadcrumb. Doesn't bill. |
| `Sankofa.setUser` / `setTag(s)` / `setExtra` / `addBreadcrumb` | Ambient context. |
| `Sankofa.withScope(fn)` | Sentry-style temporary scope overlay. |
| `Sankofa.flushCatch()` | Force-flush queued Catch events. |

### `catchPlugin` options

| Option | Type | Description |
|---|---|---|
| `release` | `string?` | Bundle identifier for source-map matching. |
| `appVersion` | `string?` | App version sent in the device context. |
| `environment` | `"live" \| "test"` | Default `"live"`. |
| `captureUnhandled` | `boolean?` | Default `true`. |
| `captureRejections` | `boolean?` | Default `true`. |
| `captureConsoleError` | `boolean?` | Default `false`. |
| `autocapture` | `boolean?` | Default `true`. Hooks console / fetch / XHR / clicks / nav. |
| `capturePerformance` | `boolean?` | Default `true`. Web Vitals + pageload transaction. |
| `beforeSend` | `(event) => event \| null` | Synchronous hook. Throws swallowed. |
| `readFlagSnapshot` | `() => Record<string, string> \| undefined` | Override the auto-discovered flag snapshot. |
| `readConfigSnapshot` | `() => Record<string, unknown> \| undefined` | Override the auto-discovered config snapshot. |

## Documentation

Full API reference: [docs.sankofa.dev/sdks/web/packages/catch](https://docs.sankofa.dev/sdks/web/packages/catch).

## License

MIT
