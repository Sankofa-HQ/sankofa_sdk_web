import { SankofaBrowserClient } from "./client";
export { createPersistentQueue } from "./storage";
export type {
  PersistentQueue,
  QueuedRecord,
  SankofaAliasPayload,
  SankofaAutocaptureOptions,
  SankofaBatchOperation,
  SankofaClientSnapshot,
  SankofaFlushOptions,
  SankofaInitOptions,
  SankofaModuleName,
  SankofaPeoplePayload,
  SankofaPlugin,
  SankofaPluginContext,
  SankofaPluginInstance,
  SankofaPropertyMap,
  SankofaTrackPayload,
  SankofaTransportValue,
} from "./types";
export {
  SANKOFA_BROWSER_VERSION,
  resolveBatchUrl,
  resolveReplayChunkUrl,
  resolveServerBaseUrl,
  resolveTrackUrl,
  resolveV1BaseUrl,
  serializeTransportProperties,
  serializeTransportValue,
} from "./utils";

const client = new SankofaBrowserClient();

export const Sankofa = {
  init(options: import("./types").SankofaInitOptions) {
    return client.init(options);
  },
  track(eventName: string, properties?: import("./types").SankofaPropertyMap) {
    return client.track(eventName, properties);
  },
  identify(userId: string, traits?: import("./types").SankofaPropertyMap) {
    return client.identify(userId, traits);
  },
  peopleSet(traits: import("./types").SankofaPropertyMap) {
    return client.peopleSet(traits);
  },
  setPerson(properties: { name?: string; email?: string; avatar?: string } & import("./types").SankofaPropertyMap) {
    return client.setPerson(properties);
  },
  reset() {
    return client.reset();
  },
  flush(options?: import("./types").SankofaFlushOptions) {
    return client.flush(options);
  },
  shutdown() {
    return client.shutdown();
  },
  getSnapshot() {
    return client.getSnapshot();
  },
};

export { SankofaBrowserClient };
