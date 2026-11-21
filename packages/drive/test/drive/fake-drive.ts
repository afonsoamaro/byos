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
  /** Created by another app: under `drive.file` Drive refuses it with a 403. */
  foreign?: boolean;
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
    // Copies, so a test that mutates a shared fixture array can't leak into the next test.
    [{ id: 'root', name: 'My Drive', parents: [], mimeType: FOLDER }, ...initial].map((f) => [
      f.id,
      { ...f, parents: [...f.parents] },
    ]),
  );
  const requests: DriveRequest[] = [];
  const queued: {
    match: RegExp | ((request: DriveRequest) => boolean);
    reply: FakeDriveReply;
    apply: boolean;
  }[] = [];
  let nextId = 1;
  interface UploadSession {
    metadata: {
      name?: string;
      parents?: string[];
      mimeType?: string;
      appProperties?: Record<string, string>;
    };
    mimeType: string;
    size: number;
    existingId?: string;
    received: Uint8Array<ArrayBuffer>;
    fileId?: string;
  }
  const sessions = new Map<string, UploadSession>();
  const control = { confirmShort: undefined as number | undefined, expired: false };
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

  const resumable = (
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer>,
  ): Response | undefined => {
    const uploadId = url.searchParams.get('upload_id');
    if (uploadId === null) {
      if (url.searchParams.get('uploadType') !== 'resumable') return undefined;
      const metadata = JSON.parse(new TextDecoder().decode(body)) as UploadSession['metadata'];
      const existing = /\/files\/([^/]+)$/.exec(url.pathname)?.[1];
      const id = `SECRET-${String(nextId++)}`;
      sessions.set(id, {
        metadata,
        mimeType: headers['x-upload-content-type'] ?? 'application/octet-stream',
        size: Number(headers['x-upload-content-length']),
        ...(existing === undefined ? {} : { existingId: decodeURIComponent(existing) }),
        received: new Uint8Array(0),
      });
      return new Response(null, {
        status: 200,
        headers: {
          location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`,
        },
      });
    }
    const session = sessions.get(uploadId);
    if (!session || control.expired) return json(404, driveError(404, 'notFound').body);
    const finished = () => {
      const file = session.fileId === undefined ? undefined : files.get(session.fileId);
      return file ? json(200, resource(file)) : undefined;
    };
    const incomplete = () =>
      new Response(null, {
        status: 308,
        headers:
          session.received.length > 0
            ? { range: `bytes=0-${String(session.received.length - 1)}` }
            : {},
      });
    const range = headers['content-range'] ?? '';
    if (/^bytes \*\/\d+$/.test(range)) return finished() ?? incomplete();
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (
      !match ||
      Number(match[1]) !== session.received.length ||
      Number(match[2]) - Number(match[1]) + 1 !== body.length
    ) {
      return json(400, driveError(400, 'badContentRange').body);
    }
    let kept = body;
    if (control.confirmShort !== undefined) {
      kept = body.slice(0, control.confirmShort);
      control.confirmShort = undefined;
    }
    const merged = new Uint8Array(session.received.length + kept.length);
    merged.set(session.received);
    merged.set(kept, session.received.length);
    session.received = merged;
    if (session.received.length < session.size) return incomplete();
    const meta = session.metadata;
    if (session.existingId !== undefined) {
      const file = files.get(session.existingId);
      if (!file) return json(404, driveError(404, 'notFound').body);
      Object.assign(file, {
        bytes: session.received,
        mimeType: session.mimeType,
        appProperties: meta.appProperties,
      });
      session.fileId = file.id;
    } else {
      const file: FakeFile = {
        id: `new-${String(nextId++)}`,
        name: meta.name ?? '',
        parents: meta.parents ?? [],
        mimeType: session.mimeType,
        bytes: session.received,
        ...(meta.appProperties ? { appProperties: meta.appProperties } : {}),
      };
      files.set(file.id, file);
      session.fileId = file.id;
    }
    return finished();
  };

  const write = (
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer>,
  ) => {
    const viaSession = resumable(method, url, headers, body);
    if (viaSession) return viaSession;
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
    const item = /^\/drive\/v3\/files\/([^/]+)(\/copy)?$/.exec(url.pathname);
    if (item) {
      const file = files.get(decodeURIComponent(item[1] ?? ''));
      if (!file) return json(404, driveError(404, 'notFound').body);
      if (file.foreign) return json(403, driveError(403, 'appNotAuthorizedToFile').body);
      if (item[2] === '/copy' && method === 'POST') {
        const meta = JSON.parse(new TextDecoder().decode(body)) as {
          name: string;
          parents: string[];
          appProperties?: Record<string, string>;
        };
        const copy: FakeFile = {
          id: `new-${String(nextId++)}`,
          name: meta.name,
          parents: meta.parents,
          mimeType: file.mimeType ?? 'application/octet-stream',
          ...(file.bytes ? { bytes: file.bytes.slice() } : {}),
          ...(meta.appProperties ? { appProperties: meta.appProperties } : {}),
        };
        files.set(copy.id, copy);
        return json(200, resource(copy));
      }
      if (method === 'PATCH') {
        const meta = JSON.parse(new TextDecoder().decode(body) || '{}') as {
          name?: string;
          trashed?: boolean;
        };
        const add = url.searchParams.get('addParents');
        const remove = url.searchParams.get('removeParents');
        if (add) file.parents = [...file.parents.filter((p) => p !== remove), add];
        if (meta.name !== undefined) file.name = meta.name;
        if (meta.trashed !== undefined) file.trashed = meta.trashed;
        return json(200, resource(file));
      }
      if (method === 'DELETE') {
        const doomed = new Set([file.id]);
        for (let grew = true; grew;) {
          grew = false;
          for (const other of files.values()) {
            if (!doomed.has(other.id) && other.parents.some((p) => doomed.has(p))) {
              doomed.add(other.id);
              grew = true;
            }
          }
        }
        for (const id of doomed) files.delete(id);
        return new Response(null, { status: 204 });
      }
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
    const request = requests[requests.length - 1] as DriveRequest;
    const index = queued.findIndex((entry) =>
      entry.match instanceof RegExp
        ? entry.match.test(url.pathname + url.search)
        : entry.match(request),
    );
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
    /** The next request the predicate accepts is carried out, then answers with this failure. */
    failAfterApplyWhen(match: (request: DriveRequest) => boolean, reply: FakeDriveReply) {
      queued.push({ match, reply, apply: true });
    },
    /** The next resumable chunk keeps (and confirms) only its first `bytes` bytes. */
    confirmShort(bytes: number) {
      control.confirmShort = bytes;
    },
    /** Every resumable session answers 404 from now on. */
    expireSessions() {
      control.expired = true;
    },
    sessions,
    /** The next matching request is carried out, but answers with this failure. */
    failAfterApply(match: RegExp, reply: FakeDriveReply) {
      queued.push({ match, reply, apply: true });
    },
  };
}
