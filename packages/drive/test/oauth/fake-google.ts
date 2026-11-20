// A scripted stand-in for Google's OAuth endpoints: replies come from a queue, requests are
// recorded with their form body decoded.

export type FakeReply = { status: number; body: unknown } | Error;

export interface RecordedRequest {
  url: string;
  method: string;
  body: Record<string, string>;
}

export function fakeGoogle(replies: FakeReply[]) {
  const requests: RecordedRequest[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: Object.fromEntries(new URLSearchParams(body)),
    });
    const reply = replies.shift();
    if (!reply) return Promise.reject(new Error('fake Google has no reply queued'));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, requests };
}

export const tokenReply = (accessToken: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    access_token: accessToken,
    expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/drive.file',
    token_type: 'Bearer',
    ...extra,
  },
});

export const DAY = 24 * 60 * 60 * 1000;
