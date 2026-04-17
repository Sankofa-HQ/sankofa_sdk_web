import type {
  SankofaClientSnapshot,
  SankofaFlushOptions,
  SankofaModuleName,
  SankofaPlugin,
  SankofaPluginContext,
  SankofaPluginInstance,
} from "./types";

export class SankofaPluginManager {
  private plugins: SankofaPluginInstance[] = [];
  /** Map from canonical module name to the plugin instance handling it. */
  private modulePlugins: Map<SankofaModuleName, SankofaPluginInstance> = new Map();
  private debug: (message: string, ...details: unknown[]) => void;

  constructor(options: { debug: (message: string, ...details: unknown[]) => void }) {
    this.debug = options.debug;
  }

  /**
   * Announce which canonical modules have plugins configured, before
   * `setup()` fully constructs them. The Reverse Handshake uses this to
   * report `installed_modules` to the server — the server needs to
   * know what the app ships with BEFORE any async plugin construction.
   * Setup-time `applyHandshake` routing still waits for full setup.
   */
  preregisterModules(plugins: SankofaPlugin[]): void {
    for (const p of plugins) {
      if (p.moduleName) {
        // Stub entry so getInstalledModules() reports it. The real
        // instance replaces this during setup().
        this.modulePlugins.set(p.moduleName, {});
      }
    }
  }

  async setup(plugins: SankofaPlugin[], context: SankofaPluginContext): Promise<void> {
    this.modulePlugins.clear();

    if (plugins.length === 0) {
      this.plugins = [];
      return;
    }

    const instances = await Promise.all(
      plugins.map(async (plugin) => {
        try {
          const instance = await plugin.setup(context);
          this.debug(`Plugin ready: ${plugin.name}`);
          const resolved = instance ?? {};
          // Traffic Cop: if the plugin claims a canonical module, index it
          // so the handshake handler can route server flags to it.
          if (plugin.moduleName) {
            this.modulePlugins.set(plugin.moduleName, resolved);
          }
          return resolved;
        } catch (error) {
          this.debug(`Plugin setup failed: ${plugin.name}`, error);
          return {};
        }
      }),
    );

    this.plugins = instances;
  }

  /** Which canonical modules are represented by currently loaded plugins. */
  getInstalledModules(): SankofaModuleName[] {
    // Analytics is always present (the core IS the analytics module).
    const names: SankofaModuleName[] = ["analytics"];
    for (const name of this.modulePlugins.keys()) {
      if (name !== "analytics") names.push(name);
    }
    return names;
  }

  /**
   * The Traffic Cop. Routes each enabled module flag from the handshake
   * response to its registered plugin. Missing plugins get a dev-mode
   * warning and a silent no-op in production — a dashboard toggle can
   * never activate code that isn't loaded.
   */
  async routeHandshake(modules: Record<string, any> | null | undefined): Promise<void> {
    if (!modules) return;

    const check = async (name: SankofaModuleName, friendlyName: string, installHint: string) => {
      const cfg = modules[name];
      if (!cfg || cfg.enabled !== true) return;
      const plugin = this.modulePlugins.get(name);
      if (plugin?.applyHandshake) {
        try {
          await plugin.applyHandshake(cfg);
        } catch (error) {
          this.debug(`Plugin ${name}.applyHandshake failed`, error);
        }
      } else if (!plugin) {
        // Dev warning only — we check debug by emitting via this.debug
        // which the client wires to console.warn in development.
        this.debug(
          `[Sankofa] Server enabled "${friendlyName}" but no plugin for it is loaded. ` +
          installHint,
        );
      }
    };

    await check("deploy", "deploy", "Install @sankofa/deploy and pass deployPlugin() to plugins[].");
    await check("catch", "catch", "Install @sankofa/catch and pass catchPlugin() to plugins[].");
  }

  async notifyDistinctIdChange(
    current: SankofaClientSnapshot,
    previous: SankofaClientSnapshot,
  ): Promise<void> {
    await Promise.all(
      this.plugins.map(async (plugin) => {
        try {
          if (plugin.onDistinctIdChange) {
            await plugin.onDistinctIdChange(current, previous);
          }
        } catch (error) {
          this.debug("Plugin distinct ID change hook failed", error);
        }
      }),
    );
  }

  async notifySessionChange(
    current: SankofaClientSnapshot,
    previous: SankofaClientSnapshot,
  ): Promise<void> {
    await Promise.all(
      this.plugins.map(async (plugin) => {
        try {
          if (plugin.onSessionChange) {
            await plugin.onSessionChange(current, previous);
          }
        } catch (error) {
          this.debug("Plugin session change hook failed", error);
        }
      }),
    );
  }

  async notifyHighFidelity(): Promise<void> {
    await Promise.all(
      this.plugins.map(async (plugin) => {
        try {
          if (plugin.onHighFidelity) {
            await plugin.onHighFidelity();
          }
        } catch (error) {
          this.debug("Plugin high fidelity hook failed", error);
        }
      }),
    );
  }

  async flush(options: SankofaFlushOptions): Promise<void> {
    await Promise.all(
      this.plugins.map(async (plugin) => {
        try {
          if (plugin.flush) {
            await plugin.flush(options);
          }
        } catch (error) {
          this.debug("Plugin flush failed", error);
        }
      }),
    );
  }

  async shutdown(): Promise<void> {
    if (this.plugins.length === 0) return;
    
    await Promise.all(
      this.plugins.map(async (plugin) => {
        try {
          if (plugin.shutdown) {
            await plugin.shutdown();
          }
        } catch (error) {
          this.debug("Plugin shutdown failed", error);
        }
      }),
    );
    this.plugins = [];
  }
}
