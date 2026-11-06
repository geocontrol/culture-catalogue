/* ATProto OAuth for Culture Catalogue's "Add yourself" journey — a public
 * browser client.
 *
 * Copied from cultureblocs-site start/lib/oauth.js (itself from
 * went/lib/oauth.js and pocket/oauth.js). Kept as a separate copy for the
 * reason those files record: the client id is a URL, so each app that signs
 * people in needs its own metadata document and its own storage keys. On
 * localhost the client id becomes an ATProto loopback client
 * (http://localhost?redirect_uri=…), so it can be signed into from a dev
 * server without a deployed metadata file.
 *
 * Addition here: startSignup(host) — create a new account in the middle of
 * the flow. The request goes to the chosen host's authorisation server with
 * prompt=create and no account named; the account the token comes back for
 * is then checked to live on that same server before it is trusted.
 *
 * Enough of the spec to sign a person in with their own handle and write
 * records to their own repository: PKCE, pushed authorisation requests,
 * and DPoP proof-of-possession. No secrets, no backend.
 *
 * The private DPoP key is generated non-extractable and kept in
 * IndexedDB, so even a successful XSS cannot copy it out — tokens are
 * bound to it and are useless without it.
 */
const GENERIC = 'atproto transition:generic';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const DEV_REDIRECT = `http://127.0.0.1:${location.port}${location.pathname.replace(/[^/]*$/, '')}`;
const CLIENT_ID = LOOPBACK
  ? `http://localhost?redirect_uri=${encodeURIComponent(DEV_REDIRECT)}` +
    `&scope=${encodeURIComponent(GENERIC)}`
  : document.querySelector('link[rel="atproto-client"]')?.href
    || `${location.origin}${location.pathname.replace(/\/?$/, '/')}client-metadata.json`;
const REDIRECT_URI = LOOPBACK ? DEV_REDIRECT : CLIENT_ID.replace(/client-metadata\.json$/, '');
/* Each app that signs people in is its own OAuth client (its own metadata
 * URL), so each keeps its own session and key: <meta name="oauth-store">
 * names the store; "start" by default. */
const STORE = document.querySelector('meta[name="oauth-store"]')?.content || 'catalogue';
const P = `${STORE}:`;   // storage prefix
const PUBLIC_API = 'https://public.api.bsky.app/xrpc';

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => crypto.subtle.digest('SHA-256', enc.encode(s));
const jget = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};

/* ---------- tiny IndexedDB for the DPoP key ---------- */
function idb(mode, fn) {
  return new Promise((res, rej) => {
    const open = indexedDB.open(`${STORE}-oauth`, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => rej(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    };
  });
}
const idbGet = k => idb('readonly', s => s.get(k));
const idbPut = (k, v) => idb('readwrite', s => s.put(v, k));
const idbDel = k => idb('readwrite', s => s.delete(k));

/* ---------- DPoP ---------- */
let keyPair = null, publicJwk = null;

async function ensureKey() {
  if (keyPair) return keyPair;
  keyPair = await idbGet('dpop');
  if (!keyPair) {
    // public keys are always extractable; the private key never leaves here
    keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await idbPut('dpop', keyPair);
  }
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  return keyPair;
}

async function dpopProof(htm, htu, { nonce, accessToken } = {}) {
  await ensureKey();
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk };
  const payload = {
    jti: rand(16), htm, htu: htu.split('?')[0],
    iat: Math.floor(Date.now() / 1000),
    ...(nonce ? { nonce } : {}),
    ...(accessToken ? { ath: b64url(await sha256(accessToken)) } : {}),
  };
  const body = `${b64url(enc.encode(JSON.stringify(header)))}.` +
               `${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

/* Servers demand a nonce they choose; the first attempt is expected to
 * fail and hand one back in a header. Retry once, transparently. */
const nonces = {};
async function dpopFetch(url, opts = {}, accessToken) {
  const origin = new URL(url).origin;
  const send = async () => {
    const headers = new Headers(opts.headers || {});
    headers.set('DPoP', await dpopProof(opts.method || 'GET', url,
      { nonce: nonces[origin], accessToken }));
    if (accessToken) headers.set('Authorization', `DPoP ${accessToken}`);
    return fetch(url, { ...opts, headers });
  };
  let res = await send();
  const fresh = res.headers.get('DPoP-Nonce');
  if (fresh) nonces[origin] = fresh;
  if (res.status === 401 || res.status === 400) {
    const clone = res.clone();
    let err = '';
    try { err = (await clone.json()).error || ''; } catch (e) {}
    if (err === 'use_dpop_nonce' && fresh) res = await send();
  }
  return res;
}

/* ---------- identity ---------- */
export async function resolveHandle(handle) {
  handle = handle.trim().replace(/^@/, '');
  if (handle.startsWith('did:')) return handle;
  try {
    const d = await jget(`${PUBLIC_API}/com.atproto.identity.resolveHandle` +
      `?handle=${encodeURIComponent(handle)}`);
    return d.did;
  } catch (e) { /* fall through */ }
  const dns = await jget('https://dns.google/resolve?name=' +
    encodeURIComponent(`_atproto.${handle}`) + '&type=TXT');
  for (const a of (dns.Answer || [])) {
    const v = (a.data || '').replace(/"/g, '');
    if (v.startsWith('did=')) return v.slice(4);
  }
  throw new Error(`couldn't find an account for ${handle}`);
}

async function didDoc(did) {
  return did.startsWith('did:web:')
    ? jget(`https://${did.slice(8).replace(/:/g, '/')}/.well-known/did.json`)
    : jget(`https://plc.directory/${did}`);
}

async function handleOf(did) {
  try {
    const aka = ((await didDoc(did)).alsoKnownAs || []).find(a => String(a).startsWith('at://'));
    return aka ? aka.slice(5) : did;
  } catch (e) { return did; }
}

export async function resolvePds(did) {
  const doc = did.startsWith('did:web:')
    ? await jget(`https://${did.slice(8).replace(/:/g, '/')}/.well-known/did.json`)
    : await jget(`https://plc.directory/${did}`);
  const svc = (doc.service || []).find(s => (s.id || '').endsWith('#atproto_pds'));
  if (!svc) throw new Error('no PDS found for this account');
  return svc.serviceEndpoint;
}

async function authServer(pds) {
  let issuer = pds;
  try {
    const prm = await jget(`${pds}/.well-known/oauth-protected-resource`);
    if (prm.authorization_servers?.length) issuer = prm.authorization_servers[0];
  } catch (e) { /* older PDSs: the PDS is its own authorisation server */ }
  return checkedMeta(issuer, await jget(`${issuer}/.well-known/oauth-authorization-server`));
}

/* Everything in this metadata came from a server chosen by whoever owns the
 * handle being signed in, and authorization_endpoint ends up in location.href.
 * So: the issuer must be the server we asked (RFC 8414 §3.3), and every
 * endpoint we will navigate to or POST to must be plain https — never
 * javascript:, data: or http:. */
const httpsUrl = (u) => {
  try { return new URL(u).protocol === 'https:'; } catch (e) { return false; }
};
const sameIssuer = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
function checkedMeta(issuer, meta) {
  if (!httpsUrl(issuer) || !sameIssuer(meta?.issuer, issuer)) {
    throw new Error('sign-in server metadata does not match the server');
  }
  for (const k of ['authorization_endpoint', 'pushed_authorization_request_endpoint', 'token_endpoint']) {
    if (!httpsUrl(meta[k])) throw new Error(`sign-in server gave an unsafe ${k}`);
  }
  return meta;
}

/* ---------- sign in ---------- */
/* Servers that predate granular permissions refuse them; remember that per
 * server so the next sign-in goes straight to the broad scope. */
const genericOnly = (issuer) => localStorage.getItem(`${P}generic:${issuer}`) === '1';
export const markGenericOnly = (issuer) => localStorage.setItem(`${P}generic:${issuer}`, '1');

export async function startLogin(handle, scope = GENERIC) {
  const did = await resolveHandle(handle);
  const pds = await resolvePds(did);
  const meta = await authServer(pds);
  return beginAuth({ meta, did, pds, handle, scope, extra: { login_hint: handle } });
}

/* Create an account on `host` (e.g. https://bsky.social) as part of signing
 * in. Only for servers that advertise prompt=create. */
export async function startSignup(host, scope = GENERIC) {
  const base = String(host || '').trim().replace(/\/+$/, '');
  const url = /^https:\/\//.test(base) ? base : `https://${base}`;
  const meta = await authServer(url);
  if (!(meta.prompt_values_supported || []).includes('create')) {
    throw new Error(`${new URL(url).host} doesn’t offer sign-up from other apps — create the account on its own site, then sign in here`);
  }
  return beginAuth({ meta, did: null, pds: null, handle: null, scope, extra: { prompt: 'create' } });
}

export async function canSignUp(host) {
  try {
    const meta = await authServer(host);
    return (meta.prompt_values_supported || []).includes('create');
  } catch (e) { return false; }
}

async function beginAuth({ meta, did, pds, handle, scope, extra }) {
  const verifier = rand(48);
  const state = rand(16);
  const challenge = b64url(await sha256(verifier));

  const par = async (wanted) => {
    const form = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
      scope: wanted, state, code_challenge: challenge,
      code_challenge_method: 'S256', ...extra,
    });
    return dpopFetch(meta.pushed_authorization_request_endpoint, {
      method: 'POST', body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  };
  let asked = (LOOPBACK || genericOnly(meta.issuer)) ? GENERIC : scope;
  let res = await par(asked);
  if (!res.ok && asked !== GENERIC) {
    let err = '';
    try { err = (await res.clone().json()).error || ''; } catch (e) {}
    if (res.status === 400 && /scope/.test(err)) {
      markGenericOnly(meta.issuer);
      asked = GENERIC;
      res = await par(asked);
    }
  }
  if (!res.ok) throw new Error(`authorisation request refused (${res.status})`);
  sessionStorage.setItem(`${P}oauth-pending`, JSON.stringify(
    { verifier, state, did, pds, meta, handle, asked }));
  const { request_uri } = await res.json();
  location.href = `${meta.authorization_endpoint}` +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&request_uri=${encodeURIComponent(request_uri)}`;
}

export function pendingCallback() {
  const q = new URLSearchParams(location.search);
  return q.has('code') || q.has('error');
}

export async function completeLogin() {
  const q = new URLSearchParams(location.search);
  history.replaceState({}, '', location.pathname + location.hash);
  if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'));
  const pending = JSON.parse(sessionStorage.getItem(`${P}oauth-pending`) || 'null');
  sessionStorage.removeItem(`${P}oauth-pending`);
  if (!pending) throw new Error('no sign-in was in progress');
  if (q.get('state') !== pending.state) throw new Error('state mismatch — sign in again');
  // RFC 9207: the callback names its issuer; it must be the one we sent them to.
  if (q.has('iss') && !sameIssuer(q.get('iss'), pending.meta.issuer)) {
    throw new Error('sign-in answered by the wrong server — sign in again');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code', code: q.get('code'),
    redirect_uri: REDIRECT_URI, client_id: CLIENT_ID,
    code_verifier: pending.verifier,
  });
  const res = await dpopFetch(pending.meta.token_endpoint, {
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
  const tok = await res.json();
  let { did, pds, handle } = pending;
  if (did) {
    // The token must be for the account whose handle we resolved; anything
    // else is a server speaking for someone it isn't authoritative for.
    if (tok.sub !== did) throw new Error('sign-in returned a different account — sign in again');
  } else {
    // A new account: we only learn who it is now. It must live on a server
    // whose authorisation server is the one that just issued the token.
    if (!/^did:[a-z0-9]+:/.test(String(tok.sub || ''))) throw new Error('sign-up returned no account — try again');
    did = tok.sub;
    pds = await resolvePds(did);
    const issuer = (await authServer(pds)).issuer;
    if (!sameIssuer(issuer, pending.meta.issuer)) throw new Error('sign-up returned an account on a different server — try again');
    handle = await handleOf(did);
  }
  const session = {
    did, handle, pds,
    token_endpoint: pending.meta.token_endpoint,
    access: tok.access_token, refresh: tok.refresh_token,
    expires: Date.now() + (tok.expires_in || 3600) * 1000,
    scope: tok.scope || pending.asked, issuer: pending.meta.issuer,
  };
  localStorage.setItem(`${P}session`, JSON.stringify(session));
  return session;
}

export function session() {
  try { return JSON.parse(localStorage.getItem(`${P}session`) || 'null'); }
  catch (e) { return null; }
}

export async function signOut() {
  localStorage.removeItem(`${P}session`);
  await idbDel('dpop').catch(() => {});
  keyPair = null; publicJwk = null;
}

async function fresh() {
  const s = session();
  if (!s) throw new Error('not signed in');
  if (Date.now() < s.expires - 60000) return s;
  const res = await dpopFetch(s.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token',
      refresh_token: s.refresh, client_id: CLIENT_ID }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) { await signOut(); throw new Error('session expired — sign in again'); }
  const tok = await res.json();
  const next = { ...s, access: tok.access_token,
    refresh: tok.refresh_token || s.refresh, scope: tok.scope || s.scope,
    expires: Date.now() + (tok.expires_in || 3600) * 1000 };
  localStorage.setItem(`${P}session`, JSON.stringify(next));
  return next;
}

/* ---------- talking to the person's PDS ---------- */
async function call(method, nsid, { body, params, contentType } = {}) {
  const s = await fresh();
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const res = await dpopFetch(`${s.pds}/xrpc/${nsid}${qs}`, {
    method,
    ...(body !== undefined ? {
      body: contentType ? body : JSON.stringify(body),
      headers: { 'content-type': contentType || 'application/json' },
    } : {}),
  }, s.access);
  if (!res.ok) {
    let msg = String(res.status), code = '';
    try { const e = await res.json(); code = e.error || ''; msg = e.message || code || msg; } catch (x) {}
    const err = new Error(msg);
    err.status = res.status; err.code = code;
    throw err;
  }
  // deleteRecord may answer with an empty body on older servers
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export const createRecord = (collection, record) =>
  call('POST', 'com.atproto.repo.createRecord',
    { body: { repo: session().did, collection, record } });

/* swapRecord: the CID the caller last read. If the record has changed
 * since (edited on another device), the server refuses with InvalidSwap
 * rather than overwrite it. */
export const putRecord = (collection, rkey, record, swapRecord) =>
  call('POST', 'com.atproto.repo.putRecord',
    { body: { repo: session().did, collection, rkey, record, ...(swapRecord ? { swapRecord } : {}) } });

export const deleteRecord = (collection, rkey, swapRecord) =>
  call('POST', 'com.atproto.repo.deleteRecord',
    { body: { repo: session().did, collection, rkey, ...(swapRecord ? { swapRecord } : {}) } });

export const uploadBlob = (blob) =>
  call('POST', 'com.atproto.repo.uploadBlob',
    { body: blob, contentType: blob.type || 'application/octet-stream' })
    .then(r => r.blob);
