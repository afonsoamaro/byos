import { AuthError, ProviderError, retry, type ByosEvents, type RetryOptions } from '@byos/core';
import type { z } from 'zod';

import { networkError } from '../http-errors.js';
import type { TokenManager } from '../oauth/token-manager.js';
import { mapDriveError } from './errors.js';

export interface DriveClientOptions {
  readonly tokens: TokenManager;
  readonly fetch?: typeof fetch;
  readonly events?: ByosEvents;
  readonly retry?: RetryOptions;
  readonly now?: () => number;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Sends Drive requests with a fresh bearer token, one refresh-and-repeat on a 401, core
 * `retry` around each request, and Drive errors mapped to BYOS errors. Hook events carry
 * only the operation name and attempt: no URL, header or token.
 */
export class DriveClient {
  readonly #options: DriveClientOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: DriveClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async json<S extends z.ZodType>(operation: string, url: string, schema: S): Promise<z.infer<S>> {
    const response = await this.#request(operation, url);
    const parsed = schema.safeParse(await readJson(response));
    if (!parsed.success) {
      throw new ProviderError(`unexpected response from Google Drive (${operation})`);
    }
    return parsed.data;
  }

  /** The response body as a stream. Retries cover the request up to the headers, not the body. */
  async stream(operation: string, url: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#request(operation, url);
    return (
      response.body ??
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      })
    );
  }

  #request(operation: string, url: string): Promise<Response> {
    const { events } = this.#options;
    return retry((attempt) => this.#send(operation, url, attempt), {
      operation,
      ...(events?.onRetry === undefined ? {} : { onRetry: events.onRetry }),
      ...this.#options.retry,
    });
  }

  async #send(operation: string, url: string, attempt: number): Promise<Response> {
    const { tokens, events } = this.#options;
    events?.onRequest?.({ operation, attempt });
    const token = await tokens.getAccessToken();
    let response = await this.#fetchWith(url, token);
    if (response.status === 401) {
      const refreshed = await tokens.handleUnauthorized(token);
      response = await this.#fetchWith(url, refreshed);
      if (response.status === 401) {
        throw new AuthError(
          'Google Drive rejected the access token after a refresh; sign in again',
          {
            reason: 'invalid-grant',
          },
        );
      }
    }
    if (!response.ok) {
      throw mapDriveError(response.status, await readJson(response), response.headers, this.#now());
    }
    return response;
  }

  async #fetchWith(url: string, token: string): Promise<Response> {
    try {
      return await this.#fetch(url, { headers: { authorization: `Bearer ${token}` } });
    } catch (error) {
      throw networkError(error, 'Google Drive');
    }
  }
}
