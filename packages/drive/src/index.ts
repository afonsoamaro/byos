import { PACKAGE_NAME as CORE } from '@byos/core';

export const PACKAGE_NAME = '@byos/drive';

/** Packages this one builds on. Exercises the workspace link until real code lands. */
export const REQUIRES: readonly string[] = [CORE];

export { createAuthRequest } from './oauth/auth-request.js';
export type { AuthRequest, AuthRequestOptions } from './oauth/auth-request.js';
export { DRIVE_SCOPES } from './oauth/constants.js';
export type { DriveScope } from './oauth/constants.js';
export { exchangeCode, mergeReconnect, refreshToken, revokeToken } from './oauth/token-client.js';
export type { ExchangeCodeOptions, RefreshTokenOptions } from './oauth/token-client.js';
export { TokenManager } from './oauth/token-manager.js';
export type { TokenManagerOptions } from './oauth/token-manager.js';
export { DriveProvider } from './drive-provider.js';
export type { DriveProviderOptions } from './drive-provider.js';
export { escapeQueryValue } from './api/query.js';
