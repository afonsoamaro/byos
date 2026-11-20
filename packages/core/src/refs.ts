/**
 * A reference to a file or folder: by provider id (preferred, stable) or by a POSIX path
 * relative to the provider's root. Exactly one of the two.
 */
export type FileRef =
  { readonly id: string; readonly path?: never } | { readonly path: string; readonly id?: never };
