import type { Breadcrumb } from './types';

/**
 * BreadcrumbsBuffer — a bounded ring that holds the last N events
 * leading up to an error. Attached to every outgoing CatchEvent so
 * the dashboard can render a timeline of "what the user did right
 * before it broke".
 *
 * Default capacity is 100. Oldest entries are evicted on push.
 */
export class BreadcrumbsBuffer {
  private readonly entries: Breadcrumb[] = [];
  private capacity: number;

  constructor(capacity = 100) {
    this.capacity = Math.max(10, capacity);
  }

  setCapacity(n: number): void {
    this.capacity = Math.max(10, n);
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  push(partial: Omit<Breadcrumb, 'ts_ms'> & { ts_ms?: number }): void {
    const entry: Breadcrumb = {
      ts_ms: partial.ts_ms ?? Date.now(),
      type: partial.type ?? 'default',
      category: partial.category,
      message: partial.message,
      level: partial.level,
      data: partial.data,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  snapshot(): Breadcrumb[] {
    // Clone so callers can't mutate the buffer.
    return this.entries.map((b) => ({ ...b, data: b.data ? { ...b.data } : undefined }));
  }

  clear(): void {
    this.entries.length = 0;
  }
}

// ─── Autocapture — install browser hooks that feed the buffer ───────

interface AutocaptureOpts {
  buffer: BreadcrumbsBuffer;
  debug?: (msg: string, ...rest: unknown[]) => void;
  console?: boolean;
  fetch?: boolean;
  xhr?: boolean;
  clicks?: boolean;
  navigation?: boolean;
}

export class BreadcrumbsAutocapture {
  private installed = false;
  private uninstallers: Array<() => void> = [];
  private readonly opts: Required<AutocaptureOpts>;

  constructor(opts: AutocaptureOpts) {
    this.opts = {
      buffer: opts.buffer,
      debug: opts.debug ?? (() => {}),
      console: opts.console ?? true,
      fetch: opts.fetch ?? true,
      xhr: opts.xhr ?? true,
      clicks: opts.clicks ?? true,
      navigation: opts.navigation ?? true,
    };
  }

  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;

    if (this.opts.console) this.hookConsole();
    if (this.opts.fetch) this.hookFetch();
    if (this.opts.xhr) this.hookXHR();
    if (this.opts.clicks) this.hookClicks();
    if (this.opts.navigation) this.hookNavigation();
  }

  uninstall(): void {
    for (const u of this.uninstallers) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.uninstallers = [];
    this.installed = false;
  }

  // ── Console — capture error/warn/info as breadcrumbs ──
  private hookConsole(): void {
    const levels: Array<['error' | 'warn' | 'info' | 'log', Breadcrumb['level']]> = [
      ['error', 'error'],
      ['warn', 'warning'],
      ['info', 'info'],
      ['log', 'info'],
    ];
    const originals: Partial<Record<keyof Console, Console[keyof Console]>> = {};
    for (const [method, level] of levels) {
      const fn = (console as unknown as Record<string, (...args: unknown[]) => void>)[method];
      if (typeof fn !== 'function') continue;
      originals[method] = fn as Console[keyof Console];
      (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (
        ...args: unknown[]
      ) => {
        try {
          this.opts.buffer.push({
            type: 'console',
            category: 'console',
            level,
            message: args.map(safeStringify).join(' ').slice(0, 2048),
          });
        } catch {
          /* ignore buffer failures */
        }
        fn.apply(console, args);
      };
    }
    this.uninstallers.push(() => {
      for (const [method] of levels) {
        const orig = originals[method];
        if (orig) {
          (console as unknown as Record<string, unknown>)[method] = orig;
        }
      }
    });
  }

  // ── fetch — wrap window.fetch ──
  private hookFetch(): void {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    const original = window.fetch.bind(window);
    const buf = this.opts.buffer;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const startTs = Date.now();
      try {
        const res = await original(input as RequestInfo, init);
        buf.push({
          type: 'http',
          category: 'fetch',
          level: res.ok ? 'info' : res.status >= 500 ? 'error' : 'warning',
          message: `${method} ${url} → ${res.status}`,
          data: {
            method,
            url,
            status: res.status,
            duration_ms: Date.now() - startTs,
          },
        });
        return res;
      } catch (err) {
        buf.push({
          type: 'http',
          category: 'fetch',
          level: 'error',
          message: `${method} ${url} failed`,
          data: { method, url, error: String((err as Error)?.message ?? err) },
        });
        throw err;
      }
    };
    this.uninstallers.push(() => {
      window.fetch = original;
    });
  }

  // ── XHR ──
  private hookXHR(): void {
    if (typeof window === 'undefined' || typeof window.XMLHttpRequest !== 'function') return;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const buf = this.opts.buffer;

    type TaggedXHR = XMLHttpRequest & {
      __sankofa_method?: string;
      __sankofa_url?: string;
      __sankofa_start?: number;
    };

    XMLHttpRequest.prototype.open = function (
      this: TaggedXHR,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this.__sankofa_method = method.toUpperCase();
      this.__sankofa_url = typeof url === 'string' ? url : url.toString();
      // Cast through unknown because the open signature has optional
      // async/user/password overloads we pass through unchanged.
      return origOpen.apply(
        this,
        [method, url, ...rest] as unknown as Parameters<typeof origOpen>,
      );
    };

    XMLHttpRequest.prototype.send = function (this: TaggedXHR, ...args: unknown[]) {
      this.__sankofa_start = Date.now();
      this.addEventListener('loadend', () => {
        try {
          buf.push({
            type: 'http',
            category: 'xhr',
            level: this.status >= 500 ? 'error' : this.status >= 400 ? 'warning' : 'info',
            message: `${this.__sankofa_method ?? 'GET'} ${this.__sankofa_url ?? ''} → ${this.status}`,
            data: {
              method: this.__sankofa_method,
              url: this.__sankofa_url,
              status: this.status,
              duration_ms:
                this.__sankofa_start !== undefined ? Date.now() - this.__sankofa_start : undefined,
            },
          });
        } catch {
          /* ignore */
        }
      });
      return origSend.apply(this, args as Parameters<typeof origSend>);
    };

    this.uninstallers.push(() => {
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
    });
  }

  // ── Clicks ──
  private hookClicks(): void {
    if (typeof document === 'undefined') return;
    const buf = this.opts.buffer;

    const handler = (e: MouseEvent) => {
      try {
        const target = e.target as Element | null;
        if (!target || !target.tagName) return;
        buf.push({
          type: 'ui.click',
          category: 'ui.click',
          level: 'info',
          message: describeElement(target),
        });
      } catch {
        /* ignore */
      }
    };
    document.addEventListener('click', handler, { capture: true, passive: true });
    this.uninstallers.push(() => document.removeEventListener('click', handler, true));
  }

  // ── Navigation — pushState/replaceState/popstate ──
  private hookNavigation(): void {
    if (typeof history === 'undefined' || typeof window === 'undefined') return;
    const buf = this.opts.buffer;

    const emit = (to: string, from?: string) => {
      buf.push({
        type: 'navigation',
        category: 'navigation',
        level: 'info',
        message: `→ ${to}`,
        data: { from, to },
      });
    };

    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);

    history.pushState = (...args) => {
      const from = location.pathname;
      const ret = origPush(...args);
      emit(location.pathname, from);
      return ret;
    };
    history.replaceState = (...args) => {
      const from = location.pathname;
      const ret = origReplace(...args);
      emit(location.pathname, from);
      return ret;
    };

    const popHandler = () => emit(location.pathname);
    window.addEventListener('popstate', popHandler);

    this.uninstallers.push(() => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('popstate', popHandler);
    });
  }
}

function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : '';
  const cls = typeof el.className === 'string' && el.className
    ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
    : '';
  const text = (el.textContent ?? '').trim().slice(0, 40);
  const textSuffix = text ? ` "${text}${text.length >= 40 ? '…' : ''}"` : '';
  return `${tag}${id}${cls}${textSuffix}`;
}

function safeStringify(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return '[object]';
  }
}
