# @sankofa/browser

The core browser SDK for [Sankofa](https://sankofa.dev). Plugin host for the seven first-class products — Analytics, Catch, Switch, Config, Pulse, Replay (rrweb), Deploy. The browser package ships the core (analytics + identity + module registry + Catch statics); each product is a separate package you install on demand.

## Installation

```bash
npm install @sankofa/browser
```

## Quick Start

```ts
import { Sankofa } from '@sankofa/browser';
import { catchPlugin } from '@sankofa/catch';
import { switchPlugin } from '@sankofa/switch';
import { configPlugin } from '@sankofa/config';

Sankofa.init({
  apiKey: 'YOUR_PROJECT_API_KEY',
  endpoint: 'https://api.sankofa.dev',
  plugins: [
    // Switch + Config register themselves with the cross-module
    // registry — catchPlugin auto-discovers them at capture time
    // so every error carries the active flag + config snapshot.
    switchPlugin({ defaults: { new_checkout: false } }),
    configPlugin({ defaults: { max_uploads_per_day: 25 } }),
    catchPlugin({
      release: process.env.GIT_SHA,
      // Optional Sentry-style hook for PII scrubbing / noise filtering.
      beforeSend: (event) => {
        if (event.message?.includes('ResizeObserver loop limit')) return null;
        return event;
      },
    }),
  ],
});

// Analytics
Sankofa.track('button_clicked', { button_name: 'signup', plan: 'pro' });
Sankofa.identify('user_123');
Sankofa.setPerson({ email: 'user@example.com', name: 'John Doe' });

// Catch — Crashlytics + Sentry merged. Statics work from anywhere.
try {
  await chargeCard(amount);
} catch (err) {
  Sankofa.captureException(err);
}

Sankofa.log('checkout: applying coupon SUMMER25');  // Crashlytics-style breadcrumb
Sankofa.withScope((scope) => {
  scope.setTag('checkout_step', 'payment');
  Sankofa.captureException(err);
});
```

## Using via CDN

```html
<script src="https://cdn.jsdelivr.net/npm/@sankofa/browser/dist/sankofa.min.js"></script>
<script>
  Sankofa.init({
    apiKey: 'YOUR_PROJECT_API_KEY',
    endpoint: 'https://api.sankofa.dev',
  });
</script>
```

## Features

- **Analytics** — autocapture (page views, clicks, form submissions), identify, peopleSet, offline-first queue.
- **Catch statics** — `Sankofa.captureException` / `log` / `withScope` / `setUser` / `setTag(s)` / `setExtra` / `addBreadcrumb` / `flushCatch`. Routes to whichever Catch plugin is registered via the cross-module registry — no `getCatch()` boilerplate.
- **Plugin protocol** — `SankofaPlugin` + module registry let Switch / Config / Catch / Pulse / Replay / Deploy register themselves and discover each other.
- **Cross-module registry** — `registerModuleAPI` / `getModuleAPI` exposed for SDK authors who want their own packages to integrate.

## What's in the box

| Surface | Description |
|---|---|
| `Sankofa.init(options)` | Boot the SDK + every plugin. |
| `Sankofa.track` / `identify` / `setPerson` / `reset` / `flush` | Analytics. |
| `Sankofa.captureException` / `captureMessage` / `log` | Catch capture entry points. |
| `Sankofa.setUser` / `setTag(s)` / `setExtra` / `addBreadcrumb` | Ambient Catch context. |
| `Sankofa.withScope(fn)` | Sentry-style temporary scope overlay. |
| `Sankofa.flushCatch()` | Force-flush Catch events. |
| `registerModuleAPI` / `getModuleAPI` | Cross-plugin registry — third-party plugins can register a public API. |

## Documentation

Full API reference and integration guides: [docs.sankofa.dev/sdks/web](https://docs.sankofa.dev/sdks/web/overview).

## License

MIT
