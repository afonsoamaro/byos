import { describe, expect, it } from 'vitest';

import { configDir, dataDir, tokensDir } from '../../src/store/paths.js';

const base = { homedir: '/home/me', env: {} } as const;

describe('configDir', () => {
  it('uses %APPDATA% on Windows, with a fallback under the home folder', () => {
    expect(
      configDir({
        platform: 'win32',
        homedir: 'C:\\Users\\me',
        env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      }),
    ).toBe('C:\\Users\\me\\AppData\\Roaming\\byos');
    expect(configDir({ platform: 'win32', homedir: 'C:\\Users\\me', env: {} })).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\byos',
    );
  });

  it('uses Application Support on macOS', () => {
    expect(configDir({ platform: 'darwin', homedir: '/Users/me', env: {} })).toBe(
      '/Users/me/Library/Application Support/byos',
    );
  });

  it('uses XDG_CONFIG_HOME on Linux, else ~/.config', () => {
    expect(configDir({ ...base, platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' } })).toBe(
      '/xdg/byos',
    );
    expect(configDir({ ...base, platform: 'linux' })).toBe('/home/me/.config/byos');
    expect(configDir({ ...base, platform: 'linux', env: { XDG_CONFIG_HOME: '' } })).toBe(
      '/home/me/.config/byos',
    );
  });

  it('lets BYOS_CONFIG_DIR override every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(configDir({ ...base, platform, env: { BYOS_CONFIG_DIR: '/custom' } })).toBe('/custom');
    }
  });

  it('puts tokens in a tokens folder, with the separators of the platform', () => {
    expect(tokensDir('/c', 'linux')).toBe('/c/tokens');
    expect(tokensDir('C:\\c', 'win32')).toBe('C:\\c\\tokens');
  });
});

describe('dataDir', () => {
  it('uses %LOCALAPPDATA% on Windows', () => {
    expect(
      dataDir({
        platform: 'win32',
        homedir: 'C:\\Users\\me',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      }),
    ).toBe('C:\\Users\\me\\AppData\\Local\\byos');
  });

  it('uses Application Support on macOS and XDG_DATA_HOME on Linux', () => {
    expect(dataDir({ platform: 'darwin', homedir: '/Users/me', env: {} })).toBe(
      '/Users/me/Library/Application Support/byos',
    );
    expect(dataDir({ ...base, platform: 'linux', env: { XDG_DATA_HOME: '/xdg' } })).toBe(
      '/xdg/byos',
    );
    expect(dataDir({ ...base, platform: 'linux' })).toBe('/home/me/.local/share/byos');
  });

  it('lets BYOS_DATA_DIR override', () => {
    expect(dataDir({ ...base, platform: 'linux', env: { BYOS_DATA_DIR: '/data' } })).toBe('/data');
  });
});
