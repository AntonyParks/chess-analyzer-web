/**
 * Lichess OAuth login for a public static site: authorization code with PKCE (S256), no
 * client secret. The explorer needs no scope, so none is requested.
 *
 * Flow: ``startLogin`` stores a code verifier and state in sessionStorage and returns the
 * authorize URL to navigate to; Lichess redirects back with ``?code=…&state=…``, and
 * ``finishLogin`` checks the state and trades the code for an access token. Storage and
 * crypto are injectable so this runs under Node in tests.
 */

export const LICHESS_HOST = "https://lichess.org";
export const AUTHORIZE_URL = `${LICHESS_HOST}/oauth`;
export const TOKEN_URL = `${LICHESS_HOST}/api/token`;
export const CLIENT_ID = "chess-analyzer-web";
export const VERIFIER_KEY = "lichess-oauth-verifier";
export const STATE_KEY = "lichess-oauth-state";

/** Login failed: the user denied access, the state didn't match, or the token exchange failed. */
export class LichessLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LichessLoginError";
  }
}

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type CryptoLike = Pick<Crypto, "getRandomValues"> & { subtle: Pick<SubtleCrypto, "digest"> };

export interface AuthOptions {
  storage?: KeyValueStorage; // default: window.sessionStorage
  crypto?: CryptoLike; // default: globalThis.crypto
  clientId?: string; // default: CLIENT_ID
}

function storageOf(opts: AuthOptions): KeyValueStorage {
  if (opts.storage) return opts.storage;
  if (typeof sessionStorage === "undefined") throw new LichessLoginError("No session storage available");
  return sessionStorage;
}

function cryptoOf(opts: AuthOptions): CryptoLike {
  const c = opts.crypto ?? (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new LichessLoginError("This browser lacks WebCrypto (a secure context is needed)");
  return c;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(c: CryptoLike, n: number): string {
  return base64url(c.getRandomValues(new Uint8Array(n)));
}

/** The S256 code challenge: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string, c: CryptoLike = cryptoOf({})): Promise<string> {
  const digest = await c.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Prepare a login: store the verifier and state, and return the URL to send the user to. */
export async function startLogin(redirectUri: string, opts: AuthOptions = {}): Promise<string> {
  const c = cryptoOf(opts);
  const storage = storageOf(opts);
  const verifier = randomString(c, 32); // 43 characters, within PKCE's 43–128
  const state = randomString(c, 16);
  storage.setItem(VERIFIER_KEY, verifier);
  storage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId ?? CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: await pkceChallenge(verifier, c),
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** True when ``url`` looks like Lichess's redirect back to us (has code or error, and state). */
export function isLoginRedirect(url: string): boolean {
  const q = new URL(url).searchParams;
  return q.has("state") && (q.has("code") || q.has("error"));
}

/**
 * Complete a login from the redirect URL: verify the state and exchange the code for an
 * access token, which is returned. The stored verifier and state are removed either way.
 */
export async function finishLogin(
  currentUrl: string,
  redirectUri: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  opts: AuthOptions = {},
): Promise<string> {
  const storage = storageOf(opts);
  const q = new URL(currentUrl).searchParams;
  const expectedState = storage.getItem(STATE_KEY);
  const verifier = storage.getItem(VERIFIER_KEY);
  storage.removeItem(STATE_KEY);
  storage.removeItem(VERIFIER_KEY);
  const error = q.get("error");
  if (error) throw new LichessLoginError(`Lichess login failed: ${q.get("error_description") || error}`);
  const code = q.get("code");
  const state = q.get("state");
  if (!code) throw new LichessLoginError("Lichess sent no authorization code");
  if (!expectedState || !verifier || state !== expectedState) {
    throw new LichessLoginError("Login state did not match; please try again");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: opts.clientId ?? CLIENT_ID,
  });
  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
  } catch (exc) {
    throw new LichessLoginError(`Could not reach Lichess (${exc instanceof Error ? exc.message : exc})`);
  }
  let data: { access_token?: unknown; error_description?: unknown; error?: unknown } = {};
  try {
    data = await response.json();
  } catch {
    // handled below
  }
  if (!response.ok || typeof data.access_token !== "string" || !data.access_token) {
    const why = data.error_description || data.error || `HTTP ${response.status}`;
    throw new LichessLoginError(`Lichess refused the login (${why})`);
  }
  return data.access_token;
}

/** Revoke ``token`` at Lichess. Resolves true when Lichess accepted the revocation. */
export async function logout(
  token: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  if (!token) return true;
  try {
    const response = await fetchFn(TOKEN_URL, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}
