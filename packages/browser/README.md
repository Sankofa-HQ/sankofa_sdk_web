# @sankofa/browser

The official browser SDK for [Sankofa](https://sankofa.deva), a powerful, self-hosted analytics and session replay platform.

## Installation

```bash
npm install @sankofa/browser
```

## Quick Start

```javascript
import { Sankofa } from '@sankofa/browser';

// Initialize the SDK
Sankofa.init({
  host: 'https://api.sankofa.dev',
  apiKey: 'YOUR_PROJECT_API_KEY',
});

// Track an event
Sankofa.track('button_clicked', {
  button_name: 'signup',
  plan: 'pro'
});

// Identify a user
Sankofa.identify('user_123', {
  email: 'user@example.com',
  name: 'John Doe'
});
```

## Using via CDN

If you're not using a bundler, you can include Sankofa via a script tag:

```html
<script src="https://cdn.jsdelivr.net/npm/@sankofa/browser/dist/sankofa.min.js"></script>
<script>
  Sankofa.init({
    host: 'https://api.sankofa.dev',
    apiKey: 'YOUR_PROJECT_API_KEY'
  });
</script>
```

## Features

- **Autocapture**: Automatically track page views, clicks, and form submissions.
- **Identity Management**: Easily track user journeys across sessions.
- **Privacy First**: Built-in support for PII masking and GDPR compliance.
- **Pluggable**: Extend functionality with plugins like Session Replay.

## License

MIT
