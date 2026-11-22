import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { CliError } from './errors.js';

const desktopSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
  }),
});

export interface DesktopClient {
  readonly clientId: string;
  /** Desktop clients have one that Google treats as non-confidential. */
  readonly clientSecret?: string;
}

/** Loads the OAuth client JSON Google Cloud lets you download. It has to be a Desktop app. */
export async function loadDesktopClient(path: string): Promise<DesktopClient> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`can't read the client file ${path}`, 2, 'USAGE');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CliError(`the client file ${path} is not valid JSON`, 2, 'USAGE');
  }
  const keys = typeof json === 'object' && json !== null ? Object.keys(json) : [];
  if (keys.length !== 1 || keys[0] !== 'installed') {
    const kind = keys.join(', ') || 'unknown';
    throw new CliError(
      `this client file is not a Desktop app client (it is "${kind}"). Create an OAuth client of type "Desktop app"; byos doctor explains the steps.`,
      5,
      'AUTH_FAILED',
    );
  }
  const parsed = desktopSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      `the client file ${path} has an "installed" block without a client_id`,
      2,
      'USAGE',
    );
  }
  const { client_id, client_secret } = parsed.data.installed;
  return {
    clientId: client_id,
    ...(client_secret === undefined ? {} : { clientSecret: client_secret }),
  };
}
