import {
  AuthError,
  NotFoundError,
  ProviderError,
  retry,
  type ByosEvents,
  type RetryOptions,
} from '@byos/core';
import type { z } from 'zod';

import { networkError } from '../http-errors.js';
import type { TokenManager } from '../oauth/token-manager.js';
import { mapDriveError } from './errors.js';

/** A request's method, extra headers and body; the body is reused as is on a retry. */
export interface DriveRequestInit {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array<ArrayBuffer> | string;
}

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

  /** A JSON request inside the core `retry`. */
  async json<S extends z.ZodType>(
    operation: string,
    url: string,
    schema: S,
    init?: DriveRequestInit,
  ): Promise<z.infer<S>> {
    return this.#parse(operation, await this.#request(operation, url, init), schema);
  }

  /**
   * A single attempt (with the 401 refresh, without `retry`), for requests that aren't
   * idempotent: the caller retries with its own reconciliation.
   */
  async jsonOnce<S extends z.ZodType>(
    operation: string,
    url: string,
    schema: S,
    init?: DriveRequestInit,
  ): Promise<z.infer<S>> {
    return this.#parse(operation, await this.#send(operation, url, 1, init), schema);
  }

  async #parse<S extends z.ZodType>(
    operation: string,
    response: Response,
    schema: S,
  ): Promise<z.infer<S>> {
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

  #request(operation: string, url: string, init?: DriveRequestInit): Promise<Response> {
    const { events } = this.#options;
    return retry((attempt) => this.#send(operation, url, attempt, init), {
      operation,
      ...(events?.onRetry === undefined ? {} : { onRetry: events.onRetry }),
      ...this.#options.retry,
    });
  }

  /**
   * A request with no response body (a permanent delete), inside the core `retry`. A repeat
   * that finds nothing means the first attempt landed, so it counts as done.
   */
  async noContent(operation: string, url: string, init?: DriveRequestInit): Promise<void> {
    const { events } = this.#options;
    await retry(
      async (attempt) => {
        try {
          await this.#send(operation, url, attempt, init);
        } catch (error) {
          if (attempt > 1 && error instanceof NotFoundError) return;
          throw error;
        }
      },
      {
        operation,
        ...(events?.onRetry === undefined ? {} : { onRetry: events.onRetry }),
        ...this.#options.retry,
      },
    );
  }

  /**
   * One attempt with the 401 refresh, returning the response whatever its status: for the
   * resumable protocol, where a 308 is progress, not an error.
   */
  rawOnce(operation: string, url: string, init?: DriveRequestInit): Promise<Response> {
    return this.#exchange(operation, url, 1, init);
  }

  async #send(
    operation: string,
    url: string,
    attempt: number,
    init?: DriveRequestInit,
  ): Promise<Response> {
    const response = await this.#exchange(operation, url, attempt, init);
    if (!response.ok) {
      throw mapDriveError(response.status, await readJson(response), response.headers, this.#now());
    }
    return response;
  }

  async #exchange(
    operation: string,
    url: string,
    attempt: number,
    init?: DriveRequestInit,
  ): Promise<Response> {
    const { tokens, events } = this.#options;
    events?.onRequest?.({ operation, attempt });
    const token = await tokens.getAccessToken();
    let response = await this.#fetchWith(url, token, init);
    if (response.status === 401) {
      const refreshed = await tokens.handleUnauthorized(token);
      response = await this.#fetchWith(url, refreshed, init);
      if (response.status === 401) {
        throw new AuthError(
          'Google Drive rejected the access token after a refresh; sign in again',
          {
            reason: 'invalid-grant',
          },
        );
      }
    }
    return response;
  }

  async #fetchWith(url: string, token: string, init?: DriveRequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        method: init?.method ?? 'GET',
        headers: { ...init?.headers, authorization: `Bearer ${token}` },
        ...(init?.body === undefined ? {} : { body: init.body }),
      });
    } catch (error) {
      throw networkError(error, 'Google Drive');
    }
  }
}
