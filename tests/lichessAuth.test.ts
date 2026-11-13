import { describe, expect, it } from "vitest";
import {
  CLIENT_ID,
  type CryptoLike,
  type KeyValueStorage,
  LichessLoginError,
  STATE_KEY,
  VERIFIER_KEY,
  finishLogin,
  logout,
  pkceChallenge,
  startLogin,
} from "../src/data/lichessAuth";

const REDIRECT = "https://example.test/chess/";
const crypto = globalThis.crypto as CryptoLike;

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(calls: Call[], response: () => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
}

describe("PKCE", () => {
  it("challenge is base64url SHA-256 of the verifier", async () => {
    // RFC 7636 appendix B example.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await pkceChallenge(verifier, crypto)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("startLogin stores verifier and state and builds the authorize URL", async () => {
    const storage = memoryStorage();
    const url = new URL(await startLogin(REDIRECT, { storage, crypto }));
    const verifier = storage.data.get(VERIFIER_KEY)!;
    const state = storage.data.get(STATE_KEY)!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(state).toBeTruthy();
    expect(url.origin + url.pathname).toBe("https://lichess.org/oauth");
    const q = Object.fromEntries(url.searchParams);
    expect(q).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      code_challenge: await pkceChallenge(verifier, crypto),
      state,
    });
    expect(q.scope).toBeUndefined();
  });
});

describe("finishLogin", () => {
  it("rejects a state mismatch without calling Lichess", async () => {
    const storage = memoryStorage();
    await startLogin(REDIRECT, { storage, crypto });
    const calls: Call[] = [];
    const f = fakeFetch(calls, () => new Response("{}"));
    await expect(finishLogin(`${REDIRECT}?code=abc&state=forged`, REDIRECT, f, { storage })).rejects.toBeInstanceOf(
      LichessLoginError,
    );
    expect(calls).toHaveLength(0);
    expect(storage.data.size).toBe(0); // one-shot: the verifier is gone
  });

  it("posts the token request as form data and returns the token", async () => {
    const storage = memoryStorage();
    await startLogin(REDIRECT, { storage, crypto });
    const verifier = storage.data.get(VERIFIER_KEY)!;
    const state = storage.data.get(STATE_KEY)!;
    const calls: Call[] = [];
    const f = fakeFetch(
      calls,
      () => new Response(JSON.stringify({ token_type: "Bearer", access_token: "fake-token" }), { status: 200 }),
    );
    const token = await finishLogin(`${REDIRECT}?code=the-code&state=${state}`, REDIRECT, f, { storage });
    expect(token).toBe("fake-token");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://lichess.org/api/token");
    expect(calls[0].init?.method).toBe("POST");
    const body = calls[0].init?.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
    });
  });

  it("reports a denied login and a refused exchange", async () => {
    const storage = memoryStorage();
    await startLogin(REDIRECT, { storage, crypto });
    const state = storage.data.get(STATE_KEY)!;
    await expect(
      finishLogin(`${REDIRECT}?error=access_denied&state=${state}`, REDIRECT, fakeFetch([], () => new Response()), {
        storage,
      }),
    ).rejects.toThrow(/access_denied/);

    await startLogin(REDIRECT, { storage, crypto });
    const state2 = storage.data.get(STATE_KEY)!;
    const bad = fakeFetch([], () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(finishLogin(`${REDIRECT}?code=x&state=${state2}`, REDIRECT, bad, { storage })).rejects.toThrow(
      /invalid_grant/,
    );
  });
});

describe("logout", () => {
  it("revokes the token with DELETE and a bearer header", async () => {
    const calls: Call[] = [];
    const ok = await logout("fake-token", fakeFetch(calls, () => new Response(null, { status: 204 })));
    expect(ok).toBe(true);
    expect(calls[0].url).toBe("https://lichess.org/api/token");
    expect(calls[0].init?.method).toBe("DELETE");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer fake-token");
  });
});
