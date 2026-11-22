import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { CliError } from './errors.js';
import { ensurePrivateDir, writeFileAtomic } from './store/atomic-write.js';

const configSchema = z.object({
  clientFile: z.string().optional(),
  account: z.object({ email: z.string(), displayName: z.string().optional() }).optional(),
});

export type CliConfig = z.infer<typeof configSchema>;

/** `<configDir>/config.json`: where the Desktop client file is, and who is signed in. */
export class ConfigFile {
  readonly #path: string;
  readonly #dir: string;

  constructor(configDir: string) {
    this.#dir = configDir;
    this.#path = join(configDir, 'config.json');
  }

  async read(): Promise<CliConfig> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      return configSchema.parse(JSON.parse(text));
    } catch {
      throw new CliError(
        `the config file ${this.#path} is damaged; remove it and run byos auth again`,
        1,
        'CONFIG_INVALID',
      );
    }
  }

  async write(config: CliConfig): Promise<void> {
    await ensurePrivateDir(this.#dir);
    await writeFileAtomic(this.#path, `${JSON.stringify(config, null, 2)}\n`);
  }
}
