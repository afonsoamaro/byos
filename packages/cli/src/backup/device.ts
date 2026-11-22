/**
 * The device part of the remote layout: the host name with anything outside letters, digits,
 * dot, underscore, space and hyphen replaced by a hyphen, so it is safe as a Drive folder name.
 */
export function deviceName(hostname: string): string {
  const safe = hostname.replace(/[^A-Za-z0-9._ -]/g, '-').trim();
  return safe === '' || safe === '.' || safe === '..' ? 'device' : safe;
}
