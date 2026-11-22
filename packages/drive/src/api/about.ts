import { z } from 'zod';

export const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about';

/** `about.get` with only the signed-in user, which `drive.file` is enough to read. */
export const aboutSchema = z.object({
  user: z.object({
    emailAddress: z.string().min(1),
    displayName: z.string().optional(),
  }),
});

export function aboutUrl(): string {
  const url = new URL(ABOUT_URL);
  url.searchParams.set('fields', 'user(emailAddress,displayName)');
  return url.toString();
}
