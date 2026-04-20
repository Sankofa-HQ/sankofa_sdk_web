import type { StackFrame, StackTrace } from './types';

/**
 * Cross-browser stack-trace parser.
 *
 * The `Error.stack` string is not standardised — every engine emits
 * its own shape. This parser supports V8/Chromium/Node (the ubiquitous
 * "at Function (file:line:col)" format), Safari's "Function@file:line:col",
 * and Firefox's "Function@file:line:col" (similar to Safari with minor
 * variations). It falls back to returning what it can when the shape
 * is unfamiliar, so an unrecognised stack never blocks an error from
 * reaching the server.
 *
 * Output is in **oldest-first** order to match the wire contract —
 * the frame where the error was thrown is LAST, and most UI
 * presentations flip it to newest-first at render time.
 */

// Chromium / V8 / Node — "at Function (file:line:col)" or
//                          "at file:line:col"
const V8_MATCHER = /^\s*at (?:(.+?)\s+\()?((?:file|https?|chrome|webpack|moz|blob):[^\s)]+|[^:\s]+)(?::(\d+))?(?::(\d+))?\)?$/;

// Safari / Firefox — "Function@file:line:col" or "@file:line:col"
const SAFARI_MATCHER = /^\s*(?:(.+?)@)?((?:file|https?|chrome|webpack|moz|blob):[^\s]+|[^@\s]+):(\d+)(?::(\d+))?$/;

// Anonymous-function placeholders from various engines.
const ANONYMOUS_FUNCTIONS = new Set([
  '',
  '<anonymous>',
  'Anonymous function',
  'anonymous',
  'eval code',
  'global code',
]);

/**
 * parseStack parses an Error.stack string (or equivalent) into a
 * StackTrace. Accepts undefined safely — some engines throw errors
 * without stacks in specific circumstances.
 */
export function parseStack(stack: string | undefined | null): StackTrace | undefined {
  if (!stack || typeof stack !== 'string') return undefined;

  const lines = stack.split('\n');
  const frames: StackFrame[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let frame: StackFrame | undefined;
    const v8 = V8_MATCHER.exec(line);
    if (v8) {
      frame = toFrame(v8[1], v8[2], v8[3], v8[4]);
    } else {
      const sf = SAFARI_MATCHER.exec(line);
      if (sf) {
        frame = toFrame(sf[1], sf[2], sf[3], sf[4]);
      }
    }
    if (frame) frames.push(frame);
  }

  if (frames.length === 0) return undefined;

  // Stacks are emitted newest-first; the wire expects oldest-first.
  frames.reverse();
  markInAppHeuristically(frames);
  return { frames };
}

function toFrame(
  func: string | undefined,
  file: string | undefined,
  lineno: string | undefined,
  colno: string | undefined,
): StackFrame {
  const frame: StackFrame = {
    platform: 'javascript',
  };

  if (func && !ANONYMOUS_FUNCTIONS.has(func)) {
    frame.function = func;
  }
  if (file) {
    frame.filename = stripQueryString(file);
    frame.abs_path = file;
  }
  if (lineno) {
    const n = Number(lineno);
    if (Number.isFinite(n) && n > 0) frame.lineno = n;
  }
  if (colno) {
    const n = Number(colno);
    if (Number.isFinite(n) && n > 0) frame.colno = n;
  }
  return frame;
}

function stripQueryString(path: string): string {
  const q = path.indexOf('?');
  return q < 0 ? path : path.slice(0, q);
}

/**
 * Heuristic in_app detection — frames whose filename sits in
 * `node_modules/`, `dist/vendor-…`, or a common third-party
 * webpack/vite chunk path are flagged `in_app: false`. Everything
 * else stays `in_app: true`. Users can override per frame by setting
 * a custom fingerprint on the event.
 */
function markInAppHeuristically(frames: StackFrame[]): void {
  for (const frame of frames) {
    if (frame.in_app !== undefined) continue;
    const file = frame.filename ?? frame.abs_path ?? '';
    if (!file) {
      frame.in_app = false;
      continue;
    }
    if (
      file.includes('/node_modules/') ||
      file.includes('/vendor-') ||
      file.includes('/polyfill') ||
      file.startsWith('webpack-internal:') ||
      file.startsWith('chrome-extension:') ||
      file.startsWith('moz-extension:') ||
      file.endsWith('.min.js')
    ) {
      frame.in_app = false;
    } else {
      frame.in_app = true;
    }
  }
}

// ─── Error → wire mapping ───────────────────────────────────────────

/**
 * errorToException normalises any thrown value (Error, DOMException,
 * string, random object) into the wire's Exception shape.
 *
 * Chained exceptions (AggregateError#errors, Error.cause) are walked
 * and emitted into the `chained` array so the dashboard can render
 * the full causal chain.
 */
export function errorToException(
  err: unknown,
  mechanism?: { type: string; handled: boolean; description?: string },
): {
  type: string;
  value: string;
  stacktrace?: StackTrace;
  module?: string;
  mechanism?: { type: string; handled: boolean; description?: string };
  chained?: ReturnType<typeof errorToException>[];
} {
  // Handle Error-like values.
  if (err && typeof err === 'object') {
    const maybeError = err as {
      name?: string;
      message?: string;
      stack?: string;
      cause?: unknown;
      errors?: unknown[];
    };

    const type = maybeError.name ?? inferTypeName(err) ?? 'Error';
    const value = String(maybeError.message ?? '');
    const stacktrace = parseStack(maybeError.stack);

    const out: ReturnType<typeof errorToException> = {
      type,
      value,
      stacktrace,
      mechanism,
    };

    // AggregateError#errors — array of causes.
    if (Array.isArray(maybeError.errors) && maybeError.errors.length > 0) {
      out.chained = maybeError.errors
        .slice(0, 5) // cap the fan-out — nobody wants a 100-deep chain
        .map((e) => errorToException(e));
    }

    // Error#cause — single-link chain.
    if (maybeError.cause !== undefined && maybeError.cause !== null && !out.chained) {
      out.chained = [errorToException(maybeError.cause)];
    }

    return out;
  }

  // Primitive or null — synthesise.
  return {
    type: 'Error',
    value: stringifyNonError(err),
    mechanism,
  };
}

function inferTypeName(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  const ctor = (err as { constructor?: { name?: string } }).constructor;
  return ctor?.name;
}

function stringifyNonError(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
