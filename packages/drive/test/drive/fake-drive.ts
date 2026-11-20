// An in-memory stand-in for the Drive v3 endpoints the provider reads. It interprets only
// the two query shapes the provider sends, checks the bearer token, pages by offset, and
// records every request with its headers.

export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType?: string;
  content?: string;
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
  const queued: { match: RegExp; reply: FakeDriveReply }[] = [];
  const state = { validToken: 'access-1' };

  const resource = (file: FakeFile) => ({
    id: file.id,
    name: file.name,
    parents: file.parents,
    mimeType: file.mimeType ?? 'application/octet-stream',
    ...(file.content === undefined
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
        return new Response(file.content ?? '', { status: 200 });
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

  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ method: init?.method ?? 'GET', url, headers });
    const index = queued.findIndex((entry) => entry.match.test(url.href));
    if (index >= 0) {
      const reply = queued.splice(index, 1)[0]?.reply ?? new Error('fake Drive queue empty');
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve(json(reply.status, reply.body ?? {}, reply.headers));
    }
    if (headers.authorization !== `Bearer ${state.validToken}`) {
      return Promise.resolve(json(401, driveError(401, 'authError').body));
    }
    return Promise.resolve(route(url));
  };

  return {
    fetch,
    files,
    requests,
    state,
    /** The next request whose URL matches gets these replies, one per request. */
    failNext(match: RegExp, ...replies: FakeDriveReply[]) {
      for (const reply of replies) queued.push({ match, reply });
    },
  };
}
