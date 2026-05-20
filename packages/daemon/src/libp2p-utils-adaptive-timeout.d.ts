declare module '@libp2p/utils/src/adaptive-timeout.js' {
  export const DEFAULT_TIMEOUT_MULTIPLIER: 1.2;
  export const DEFAULT_FAILURE_MULTIPLIER: 2;
  export const DEFAULT_MIN_TIMEOUT: 5000;
  export const DEFAULT_MAX_TIMEOUT: 60000;
  export const DEFAULT_INTERVAL: 5000;

  export interface AdaptiveTimeoutSignal extends AbortSignal {
    clear(): void;
    start: number;
    timeout: number;
  }

  export interface AdaptiveTimeoutInit {
    metricName?: string;
    metrics?: unknown;
    interval?: number;
    timeoutMultiplier?: number;
    failureMultiplier?: number;
    minTimeout?: number;
    maxTimeout?: number;
  }

  export interface GetTimeoutSignalOptions {
    timeoutFactor?: number;
    signal?: AbortSignal;
  }

  export class AdaptiveTimeout {
    constructor(init?: AdaptiveTimeoutInit);
    getTimeoutSignal(options?: GetTimeoutSignalOptions): AdaptiveTimeoutSignal;
    cleanUp(signal: AdaptiveTimeoutSignal): void;
  }
}
