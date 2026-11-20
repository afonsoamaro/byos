/** Escapes a value for a Drive query string literal: backslashes first, then single quotes. */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function childrenQuery(parentId: string): string {
  return `'${escapeQueryValue(parentId)}' in parents and trashed = false`;
}

export function childByNameQuery(parentId: string, name: string): string {
  return `'${escapeQueryValue(parentId)}' in parents and name = '${escapeQueryValue(name)}' and trashed = false`;
}
