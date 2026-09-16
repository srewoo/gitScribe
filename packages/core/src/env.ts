/**
 * Everything environment-specific enters core through this one object.
 * It is the only reason one package serves both an MV3 service worker
 * and a Node stdio process without a compatibility layer.
 */
export interface Env {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
}

export const nodeEnv: Env = {
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
};
