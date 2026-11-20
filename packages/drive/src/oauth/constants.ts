// Google OAuth 2.0 endpoints for installed and mobile apps.
export const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * The only scopes BYOS requests. `drive.file` sees just the files the app created;
 * `drive.appdata` is the app's private folder. Broader Drive scopes are refused by design.
 */
export const DRIVE_SCOPES = {
  'drive.file': 'https://www.googleapis.com/auth/drive.file',
  'drive.appdata': 'https://www.googleapis.com/auth/drive.appdata',
} as const;

export type DriveScope = keyof typeof DRIVE_SCOPES;
