# @sankofa/replay-rrweb

Session Replay plugin for the Sankofa Browser SDK, powered by [rrweb](https://github.com/rrweb-io/rrweb). View the source at [Sankofa-HQ/sankofa_sdk_web](https://github.com/Sankofa-HQ/sankofa_sdk_web).

## Installation

```bash
npm install @sankofa/browser @sankofa/replay-rrweb
```

## Usage

```javascript
import { Sankofa } from '@sankofa/browser';
import { rrwebReplayPlugin } from '@sankofa/replay-rrweb';

Sankofa.init({
  host: 'https://api.sankofa.dev',
  apiKey: 'YOUR_PROJECT_API_KEY',
  plugins: [
    rrwebReplayPlugin({
      maskAllInputs: true, // Privacy first: masks all input fields by default
    })
  ]
});
```

## Using via CDN

```html
<script src="https://cdn.jsdelivr.net/npm/@sankofa/browser/dist/sankofa.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@sankofa/replay-rrweb/dist/sankofa-replay.min.js"></script>

<script>
  Sankofa.init({
    host: 'https://api.sankofa.dev',
    apiKey: 'YOUR_PROJECT_API_KEY',
    plugins: [
      SankofaReplay.rrwebReplayPlugin()
    ]
  });
</script>
```

## Configuration

The `rrwebReplayPlugin` accepts the following options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Enable or disable recording |
| `maskAllInputs` | `boolean` | `true` | If true, all input values will be masked |
| `flushIntervalMs` | `number` | `5000` | How often to upload recording chunks |
| `maxEventsPerChunk` | `number` | `250` | Maximum number of events before a forced upload |

## License

MIT
