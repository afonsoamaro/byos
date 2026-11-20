// An in-memory stand-in for the Drive v3 endpoints the provider uses. It interprets only
// the two query shapes the provider sends, checks the bearer token, pages by offset, parses
// multipart uploads, and records every request with its headers and body.

export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType?: string;
  content?: string;
  /** Uploaded bytes; wins over `content`. */
  bytes?: Uint8Array<ArrayBuffer>;
  appProperties?: Record<string, string>;
  md5Checksum?: string;
  trashed?: boolean;
}

export type FakeDriveReply =
  { status: number; body?: unknown; headers?: Record<string, string> } | Error;

export interface DriveRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Uint8Array<ArrayBuffer>;
}

export interface MultipartParts {
  metadata: Record<string, unknown>;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Splits a `multipart/related` upload into its JSON metadata and its bytes. */
export function parseMultipart(body: Uint8Array<ArrayBuffer>, contentType: string): MultipartParts {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error('no boundary in content-type');
  const text = new TextDecoder('latin1').decode(body);
  const [, first = '', second = ''] = text.split(`--${boundary}`);
  const json = first.slice(first.indexOf('\r\n\r\n') + 4, first.lastIndexOf('\r\n'));
  const mediaHeaderEnd = second.indexOf('\r\n\r\n');
  const mimeType = /Content-Type: (.+)/.exec(second.slice(0, mediaHeaderEnd))?.[1]?.trim() ?? '';
  const start = text.indexOf(second) + mediaHeaderEnd + 4;
  const end = text.lastIndexOf(`\r\n--${boundary}--`);
  return {
    metadata: JSON.parse(json) as Record<string, unknown>,
    mimeType,
    bytes: body.slice(start, end),
  };
}

export const FOLDER = 'application/vnd.google-apps.folder';
const CHILDREN = /^'((?:[^'\\]|\\.)*)' in parents and trashed = false$/;
const BY_NAME =
  /^'((?:[^'\\]|\\.)*)' in parents and name = '((?:[^'\\]|\\.)*)' and trashed = false$/;
const unescape = (value: string) => value.replace(/\\(.)/g, '$1');

export const driveError = (status: number, reason?: string, headers?: Record<string, string>) => ({
  status,
  body: {
    error: { code: status, message: 'detail from Google', errors: reason ? [{ reason }] : [] },
  },
  ...(headers ? { headers } : {}),
});

export function fakeDrive(initial: FakeFile[] = []) {
  const files = new Map<string, FakeFile>(
    [{ id: 'root', name: 'My Drive', parents: [], mimeType: FOLDER }, ...initial].map((f) => [
      f.id,
      f,
    ]),
  );
  const requests: DriveRequest[] = [];
  const queued: { match: RegExp; reply: FakeDriveReply; apply: boolean }[] = [];
  let nextId = 1;
  const state = { validToken: 'access-1' };

  const resource = (file: FakeFile) => ({
    id: file.id,
    name: file.name,
    parents: file.parents,
    mimeType: file.mimeType ?? 'application/octet-stream',
    ...(file.bytes !== undefined
      ? { size: String(file.bytes.length) }
      : file.content === undefined
        ? {}
        : { size: String(new TextEncoder().encode(file.content).length) }),
    modifiedTime: '2026-11-01T10:00:00.000Z',
    createdTime: '2026-11-01T09:00:00.000Z',
    ...(file.md5Checksum === undefined ? {} : { md5Checksum: file.md5Checksum }),
    ...(file.appProperties === undefined ? {} : { appProperties: file.appProperties }),
    trashed: file.trashed ?? false,
  });

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const route = (url: URL): Response => {
    const match = /^\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return json(404, driveError(404).body);
    const id = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
    if (id !== undefined) {
      const file = files.get(id);
      if (!file) return json(404, driveError(404, 'notFound').body);
      if (url.searchParams.get('alt') === 'media') {
        return new Response(file.bytes ?? file.content ?? '', { status: 200 });
      }
      return json(200, resource(file));
    }
    const q = url.searchParams.get('q') ?? '';
    const live = [...files.values()].filter((f) => !f.trashed && f.id !== 'root');
    let found: FakeFile[];
    const byName = BY_NAME.exec(q);
    const children = CHILDREN.exec(q);
    if (byName) {
      const parent = unescape(byName[1] ?? '');
      const name = unescape(byName[2] ?? '');
      found = live.filter((f) => f.parents.includes(parent) && f.name === name);
    } else if (children) {
      const parent = unescape(children[1] ?? '');
      found = live.filter((f) => f.parents.includes(parent));
    } else {
      return json(400, driveError(400, 'invalidQuery').body);
    }
    const start = Number(url.searchParams.get('pageToken') ?? '0');
    const size = Number(url.searchParams.get('pageSize') ?? '100');
    const page = found.slice(start, start + size);
    const next = start + size < found.length ? { nextPageToken: String(start + size) } : {};
    return json(200, { files: page.map(resource), ...next });
  };

  const write = (
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer>,
  ) => {
    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (upload) {
      const parts = parseMultipart(body, headers['content-type'] ?? '');
      const meta = parts.metadata as {
        name?: string;
        parents?: string[];
        appProperties?: Record<string, string>;
      };
      if (method === 'PATCH') {
        const file = files.get(decodeURIComponent(upload[1] ?? ''));
        if (!file) return json(404, driveError(404, 'notFound').body);
        Object.assign(file, {
          bytes: parts.bytes,
          mimeType: parts.mimeType,
          appProperties: meta.appProperties,
        });
        return json(200, resource(file));
      }
      const file: FakeFile = {
        id: `new-${String(nextId++)}`,
        name: meta.name ?? '',
        parents: meta.parents ?? [],
        mimeType: parts.mimeType,
        bytes: parts.bytes,
        ...(meta.appProperties ? { appProperties: meta.appProperties } : {}),
      };
      files.set(file.id, file);
      return json(200, resource(file));
    }
    if (method === 'POST' && url.pathname === '/drive/v3/files') {
      const meta = JSON.parse(new TextDecoder().decode(body)) as {
        name: string;
        mimeType: string;
        parents: string[];
      };
      const file: FakeFile = {
        id: `new-${String(nextId++)}`,
        name: meta.name,
        parents: meta.parents,
        mimeType: meta.mimeType,
      };
      files.set(file.id, file);
      return json(200, resource(file));
    }
    return json(404, driveError(404).body);
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const method = init?.method ?? 'GET';
    const body =
      init?.body == null ? undefined : new Uint8Array(await new Response(init.body).arrayBuffer());
    requests.push({ method, url, headers, ...(body ? { body } : {}) });
    const index = queued.findIndex((entry) => entry.match.test(url.pathname + url.search));
    const queuedEntry = index >= 0 ? queued.splice(index, 1)[0] : undefined;
    if (queuedEntry && !queuedEntry.apply) {
      const { reply } = queuedEntry;
      if (reply instanceof Error) throw reply;
      return json(reply.status, reply.body ?? {}, reply.headers);
    }
    if (headers.authorization !== `Bearer ${state.validToken}`) {
      return json(401, driveError(401, 'authError').body);
    }
    const response =
      method === 'GET' ? route(url) : write(method, url, headers, body ?? new Uint8Array());
    if (queuedEntry) {
      // Applied, but the answer is lost: the caller sees the failure.
      const { reply } = queuedEntry;
      if (reply instanceof Error) throw reply;
      return json(reply.status, reply.body ?? {}, reply.headers);
    }
    return response;
  };

  return {
    fetch,
    files,
    requests,
    state,
    /** The next request whose path and query match gets these replies, one per request. */
    failNext(match: RegExp, ...replies: FakeDriveReply[]) {
      for (const reply of replies) queued.push({ match, reply, apply: false });
    },
    /** The next matching request is carried out, but answers with this failure. */
    failAfterApply(match: RegExp, reply: FakeDriveReply) {
      queued.push({ match, reply, apply: true });
    },
  };
}
