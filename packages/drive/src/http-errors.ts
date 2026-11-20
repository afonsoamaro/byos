import { ProviderError } from '@byos/core';

/**
 * A failed `fetch` (network down, DNS). No `cause`: a runtime's fetch error can carry the
 * request, URL and token included, in its cause chain.
 */
export function networkError(error: unknown, service: string): ProviderError {
  const name = error instanceof Error ? error.name : 'Error';
  return new ProviderError(`network error contacting ${service} (${name})`);
}
