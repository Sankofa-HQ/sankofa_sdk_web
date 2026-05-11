# @sankofa/config

Remote configuration for the web — type-safe runtime values pushed from the dashboard. Plugin to [`@sankofa/browser`](../browser).

## Installation

```bash
npm install @sankofa/browser @sankofa/config
```

## Quick Start

```ts
import { Sankofa } from '@sankofa/browser';
import { configPlugin, getConfig } from '@sankofa/config';

Sankofa.init({
  apiKey: 'YOUR_PROJECT_API_KEY',
  endpoint: 'https://api.sankofa.dev',
  plugins: [
    configPlugin({
      defaults: {
        max_uploads_per_day: 25,
        support_url: 'https://example.com/help',
        pricing_table: [{ tier: 'pro', price_cents: 4900 }],
      },
    }),
  ],
});

const config = getConfig()!;

// Typed accessor with default fallback
const maxUploads = config.get<number>('max_uploads_per_day', 25);
const supportUrl = config.get<string>('support_url', 'https://example.com');
const pricing = config.get<Array<{ tier: string; price_cents: number }>>('pricing_table', []);

// Subscribe to changes
const unsubscribe = config.onChange('pricing_table', (decision) => {
  // Re-render with the new pricing.
});
```

## Cross-module auto-discovery

When `configPlugin()` is registered, `@sankofa/catch` automatically attaches the active config values to every captured event as `config_snapshot`. The dashboard shows "what config was active when this error fired" with no host wiring.

## API

| Symbol | Description |
|---|---|
| `configPlugin(options?)` | Plugin to register at `Sankofa.init`. |
| `getConfig()` | Returns the singleton config client. |
| `config.get<T>(key, defaultValue)` | Typed value accessor. |
| `config.getDecision<T>(key)` | Full `ItemDecision` envelope. |
| `config.getAllKeys()` | All known config keys. |
| `config.getAll()` | All values as a plain object. |
| `config.onChange(key, listener)` | Subscribe to handshake-driven changes. |

## Documentation

Full reference: [docs.sankofa.dev/sdks/web/packages/config](https://docs.sankofa.dev/sdks/web/packages/config).

## License

MIT
