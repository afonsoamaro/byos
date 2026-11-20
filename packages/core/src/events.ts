import type { ErrorCode } from './errors.js';

// Payloads carry no URL, header, token or session URI, so a consumer can forward them to
// telemetry as they are.

export interface RequestEvent {
  readonly operation: string;
  readonly attempt: number;
}

export interface RetryEvent {
  readonly operation?: string;
  readonly attempt: number;
  readonly delayMs: number;
  readonly code?: ErrorCode;
}

export interface UploadProgressEvent {
  readonly name: string;
  readonly bytesConfirmed: number;
  readonly totalBytes?: number;
}

/** Optional hooks a provider calls; BYOS itself emits no telemetry. */
export interface ByosEvents {
  readonly onRequest?: (event: RequestEvent) => void;
  readonly onRetry?: (event: RetryEvent) => void;
  readonly onUploadProgress?: (event: UploadProgressEvent) => void;
}
