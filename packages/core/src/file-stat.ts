/** Metadata of one file or folder. Plain data: it survives `JSON.stringify` unchanged. */
export interface FileStat {
  /** Provider file id. Consumers persist this, not the path. */
  readonly id: string;
  readonly name: string;
  /** Ids of the parent folders. */
  readonly parents: readonly string[];
  readonly isFolder: boolean;
  /** Size in bytes. Absent for folders. */
  readonly size?: number;
  readonly mimeType?: string;
  /** RFC 3339 timestamp. */
  readonly modifiedAt?: string;
  /** RFC 3339 timestamp. */
  readonly createdAt?: string;
  /** Provider-native MD5, lowercase hex, when the provider computes one. */
  readonly md5?: string;
  /** SHA-256 written by BYOS on upload, lowercase hex. */
  readonly sha256?: string;
  readonly appProperties: Readonly<Record<string, string>>;
}

export interface ListResult {
  readonly items: readonly FileStat[];
  /** Present only when more items remain. */
  readonly nextPageToken?: string;
}
