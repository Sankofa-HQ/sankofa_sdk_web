# @sankofa/switch

Feature flags for the web. Plugin to [`@sankofa/browser`](../browser).

## Installation

```bash
npm install @sankofa/browser @sankofa/switch
```

## Quick Start

```ts
import { Sankofa } from '@sankofa/browser';
import { switchPlugin, getSwitch } from '@sankofa/switch';

Sankofa.init({
  apiKey: 'YOUR_PROJECT_API_KEY',
  endpoint: 'https://api.sankofa.dev',
  plugins: [
    switchPlugin({
      defaults: {
        new_checkout: false,
        dark_mode_default: false,
      },
    }),
  ],
});

const flags = getSwitch()!;

// Boolean
if (flags.getFlag('new_checkout')) showNewCheckout();

// Variant
const variant = flags.getVariant('checkout_redesign', 'control');

// Full decision envelope
const decision = flags.getDecision('new_checkout');
console.log(decision?.reason);  // "rollout", "cohort:pro", "halted", etc.

// Subscribe to changes (e.g. halt-webhook fires)
const unsubscribe = flags.onChange('new_checkout', (decision) => {
  // Re-render UI based on the new decision.
});
```

## Cross-module auto-discovery

When `switchPlugin()` is registered, `@sankofa/catch` automatically attaches the active flag decisions to every captured event as `flag_snapshot`. No host wiring needed — the dashboard shows "which flags were ON when this error fired" out of the box.

## API

| Symbol | Description |
|---|---|
| `switchPlugin(options?)` | Plugin to register at `Sankofa.init`. |
| `getSwitch()` | Returns the singleton flag client. |
| `flags.getFlag(key, defaultValue?)` | Boolean flag evaluation. |
| `flags.getVariant(key, defaultValue?)` | Variant flag evaluation. |
| `flags.getDecision(key)` | Full `FlagDecision` envelope (`value`, `variant`, `reason`, `version`). |
| `flags.getAllKeys()` | All known flag keys (defaults + cached). |
| `flags.onChange(key, listener)` | Subscribe to handshake-driven changes. Returns unsubscribe. |

## Documentation

Full reference: [docs.sankofa.dev/sdks/web/packages/switch](https://docs.sankofa.dev/sdks/web/packages/switch).

## License

MIT
