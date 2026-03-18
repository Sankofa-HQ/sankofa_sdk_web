import type {
  SankofaClientSnapshot,
  SankofaFlushOptions,
  SankofaPlugin,
  SankofaPluginContext,
  SankofaPluginInstance,
} from "./types";

export class SankofaPluginManager {
  private plugins: SankofaPluginInstance[] = [];
  private debug: (message: string, ...details: unknown[]) => void;

  constructor(options: { debug: (message: string, ...details: unknown[]) => void }) {
    this.debug = options.debug;
  }

  async setup(plugins: SankofaPlugin[], context: SankofaPluginContext): Promise<void> {
    if (plugins.length === 0) {
      this.plugins = [];
      return;
    }

    const instances = await Promise.all(
      plugins.map(async (plugin) => {
        try {
          const instance = await plugin.setup(context);
          this.debug(`Plugin ready: ${plugin.name}`);
          return instance ?? {};
        } catch (error) {
          this.debug(`Plugin setup failed: ${plugin.name}`, error);
          return {};
        }
      }),
    );

    this.plugins = instances;
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
