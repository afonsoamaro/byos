// The exact step that fixes each failure `byos doctor` can see. docs/google-cloud-setup.md
// (FN-18) uses these same sentences, and a test keeps the two in step. `›` prints as the
// terminal's step symbol (`>` on the legacy Windows console).
export const FIXES = {
  noClient:
    'Google Cloud console › APIs & Services › Credentials › Create credentials › OAuth client ID › Desktop app, download the JSON, then run byos auth --client <file>',
  wrongType:
    "Google Cloud console › APIs & Services › Credentials › Create credentials › OAuth client ID › Desktop app (a Web client can't use the loopback sign-in), download the JSON, then run byos auth --client <file>",
  signIn: 'run byos auth',
  publish:
    'Google Cloud console › APIs & Services › OAuth consent screen › Publish app, then run byos auth again',
  enableApi: 'Google Cloud console › APIs & Services › Library › Google Drive API › Enable',
  extraScopes:
    'revoke the app at myaccount.google.com › Security › Third-party access, then run byos auth again',
  testingMode: 'Google Cloud console › APIs & Services › OAuth consent screen › Publish app',
  network: 'check your network connection and run byos doctor again',
} as const;
