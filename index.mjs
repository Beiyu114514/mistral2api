// Mistral Vibe plan (the vibe CLI's account) for OpenCode and magpie.
// Ported in shape from the community `river` package, the reference of this
// kind: a plain OpenAI-compatible inference API behind an API key.
//
// A Vibe plan's quota is spent by the vibe CLI's own sign-in, not by a
// platform API key. The CLI signs in over OIDC at auth.mistral.ai — a
// public client registration, PKCE, a loopback redirect (confirmed from the
// open-source CLI, mistralai/mistral-vibe, vibe/setup/auth/_oidc_*.py) — and
// then sends the ID token beside the workspace headers the platform gateway
// requires (x-external-organization-id / x-external-workspace-id,
// vibe/setup/auth/_cli_oidc_platform_credentials.py) to the standard La
// Plateforme API at api.mistral.ai/v1. The workspace is discovered with the
// ID token at GET /v1/users/me/workspaces (_oidc_tenant.py). A pasted API
// key stays a fallback that reads the plain account instead.
//
// Unverified against a real account still: whether a first OIDC turn is
// paid out of the plan here as it is in the CLI. Draft until it is.

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const ID = "vibe"
const BASE = "https://api.mistral.ai/v1"

// the CLI's own OIDC registration (vibe/setup/auth/_oidc_config.py)
const ISSUER = "https://auth.mistral.ai"
const CLIENT_ID = "829da7e7-628f-4795-829a-8cca609c76d4"
const AUDIENCE = "https://api.mistral.ai"
const REDIRECT_URI = "http://127.0.0.1:8766/callback"
const SCOPE = "openid offline_access email profile"
// a non-secret stand-in for the key field, which the fetch below replaces
const OAUTH_KEY = "vibe-oidc"
// a token this close to its end is turned away before a request: renew first
const EARLY_MS = 60 * 1000
// and this close, magpie renews it ahead of time (auth.refresh)
const LEAD_MS = 10 * 60 * 1000
// the lifetime a token answer that carries no expires_in is read with: the
// hour Mistral's own grants last
const DEFAULT_ACCESS_MS = 60 * 60 * 1000
// a chat turn is one request that may run for minutes; this is the ceiling
// on the whole of it, so a connection the platform accepts and never
// answers is reported instead of hanging the turn forever. It is the same
// five minutes undici waits on its own, said out loud and with a message.
const TURN_MS = Number(process.env.VIBE_TURN_TIMEOUT_MS) > 0 ? Number(process.env.VIBE_TURN_TIMEOUT_MS) : 5 * 60 * 1000
// the length of a monthly allowance's cycle, for a window whose reset
// cannot be read
const MONTH_S = 30 * 24 * 3600

// Models a Vibe plan serves, as the bootstrap the config hook starts with
// and the fallback row for anything the live tables don't describe. The
// ids and limits marked "catalog" are the plan's own answers, read on a
// real account (GET /model-catalog?surface=vibe-code); the rest come from
// Mistral's docs at the time of writing. Every id here answered a real
// chat turn on that account; models outside the plan (devstral-*,
// mistral-large-latest) are absent from it and left out.
const BOOT = [
  { id: "mistral-large-4-0", name: "Mistral Large 4", context: 1048576, image: true, efforts: ["low", "medium", "high"] }, // catalog
  { id: "mistral-medium-latest", name: "Mistral Medium 3.5", context: 262144, image: true, efforts: ["none", "high"] }, // catalog
  { id: "mistral-vibe-cli-latest", name: "Mistral Vibe CLI", context: 262144, image: true, efforts: ["none", "high"] }, // catalog alias
  { id: "mistral-vibe-cli-fast", name: "Mistral Vibe CLI Fast", context: 262144, image: true, efforts: [] },
  { id: "mistral-vibe-cli-with-tools", name: "Mistral Vibe CLI with Tools", context: 262144, image: true, efforts: [] },
  { id: "codestral-latest", name: "Codestral", context: 262000, output: 16000, image: false, efforts: [] },
  { id: "codestral-2508", name: "Codestral 2508", context: 262000, image: false, efforts: [] },
  { id: "mistral-code-latest", name: "Mistral Code", context: 262000, image: false, efforts: [] },
  { id: "mistral-code-fim-latest", name: "Mistral Code FIM", context: 262000, image: false, efforts: [] },
  { id: "magistral-medium-latest", name: "Magistral Medium", context: 131000, output: 32000, image: false, efforts: ["none", "medium", "high"] },
  { id: "magistral-small-latest", name: "Magistral Small", context: 131000, image: false, efforts: ["none", "medium", "high"] },
  { id: "mistral-small-latest", name: "Mistral Small", context: 131000, output: 32000, image: false, efforts: [] },
  { id: "ministral-14b-latest", name: "Ministral 14B", context: 262000, image: false, efforts: [] },
  { id: "ministral-8b-latest", name: "Ministral 8B", context: 131000, output: 32000, image: false, efforts: [] },
  { id: "ministral-3b-latest", name: "Ministral 3B", context: 131000, output: 32000, image: false, efforts: [] },
  { id: "voxtral-small-latest", name: "Voxtral Small", context: 32768, image: false, efforts: [] },
]

// reasoning effort levels per model, as the field Mistral's API takes
// (the same reasoning_effort the vibe CLI sends)
const efforts = (...names) => Object.fromEntries(names.map((e) => [e, { reasoningEffort: e }]))

// rows for the model ids an account may use. The row carries the fields
// both readers use: the config hook reads the top-level ones, the models
// hook reads the capabilities object. A catalog entry, when one describes
// the model, outranks the bootstrap — it is the plan's own answer — and a
// capability it states either way wins over the bootstrap's guess, so a
// model the plan marks non-vision is not advertised with image input.
function row(boot, id, entry) {
  const b = boot?.[id] ?? {}
  const e = entry ?? {}
  const image = (e.capabilities?.vision ?? b.image) === true
  const name = e.label ?? b.name ?? id
  const context = e.max_context_length ?? b.context
  const levels = Array.isArray(e.parameters?.reasoning) ? e.parameters.reasoning.filter((x) => typeof x === "string" && x) : b.efforts
  const limits = context ? { context, output: b.output ?? 0 } : undefined
  const variants = levels?.length ? efforts(...levels) : undefined
  return {
    id,
    name,
    ...(limits ? { limit: limits } : {}),
    reasoning: !!(levels?.length ?? /magistral/i.test(id)),
    tool_call: e.capabilities?.function_calling !== false,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning: !!(levels?.length ?? /magistral/i.test(id)),
      toolcall: e.capabilities?.function_calling !== false,
      attachment: image,
      input: { text: true, image },
      output: { text: true },
    },
    ...(variants ? { variants } : {}),
  }
}

function rowsFor(ids, byId) {
  const boot = Object.fromEntries(BOOT.map((m) => [m.id, m]))
  return Object.fromEntries(ids.map((id) => [id, row(boot, id, byId?.get?.(id))]))
}

// Refused is a model table the credential may not read: the sign-in is
// what needs fixing, not the list.
class Refused extends Error {}

// tableOf reads one model table with the headers the caller decided (a
// pasted key's bearer, or an OIDC session's token and workspace headers).
// A transport failure or an unreadable body answers null — the caller
// keeps the list it has; only a refused credential is thrown.
async function tableOf(fetchImpl, url, headers) {
  let res
  try {
    res = await fetchImpl(url, {
      headers: { ...headers, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
  } catch {
    return null
  }
  if (res.status === 401 || res.status === 403) throw new Refused(url)
  if (!res.ok) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

// modelTable is what a credential may use: the vibe-code catalog the CLI
// itself reads, whose entries carry the plan's own limits and
// capabilities, plus the account's /v1/models. The catalog's ids come
// first — they are the plan's picks — and its entries index the rows.
async function modelTable(fetchImpl, headers) {
  const [catalog, account] = await Promise.all([
    tableOf(fetchImpl, `${BASE}/model-catalog?surface=vibe-code`, headers),
    tableOf(fetchImpl, `${BASE}/models`, headers),
  ])
  const entries = Array.isArray(catalog?.models)
    ? catalog.models.filter((m) => typeof m?.id === "string" && m.id)
    : []
  const accountIds = Array.isArray(account?.data)
    ? account.data.map((m) => m?.id).filter((id) => typeof id === "string" && id)
    : []
  const byId = new Map(entries.map((m) => [m.id, m]))
  return { ids: [...byId.keys(), ...accountIds.filter((id) => !byId.has(id))], byId }
}

// bearerOf is the headers a pasted key's tables are read with.
const bearerOf = (key) => ({ authorization: `Bearer ${key}` })

// billingOf reads the account's allowances the way the CLI's own footer
// reads them (vibe/app_server/_billing.py): /billing/subscription names
// the plan, /billing/budget the monthly Vibe Code allowance beside the
// platform balance. Both are optional — a platform may not serve them,
// and /budget needs the see_org_inference_usage permission — so every
// failure answers an empty read and says nothing about the sign-in: a 403
// here is a missing permission, not a refused credential.
async function billingOf(fetchImpl, headers) {
  const read = (path) => tableOf(fetchImpl, `${BASE}${path}`, headers).catch(() => null)
  const [subscription, budget] = await Promise.all([
    read("/billing/subscription"),
    read("/billing/budget"),
  ])
  return {
    plan: typeof subscription?.plan_name === "string" ? subscription.plan_name : undefined,
    windows: [
      budgetWindow(budget?.vibe_budget, "Vibe Code"),
      budgetWindow(budget?.api_budget, "API"),
    ].filter(Boolean),
  }
}

// budgetWindow is one allowance as the quota window magpie shows. Mistral
// answers the used percentage in percent — 0.3744 is 0.3744% of the
// allowance, the $0.04 of $10 the admin console shows — and the reset as
// an ISO instant; the span is the cycle that reset closes, read a month
// back from it, or the month's usual length when there is no reset.
function budgetWindow(b, name) {
  if (typeof b?.usage_percentage !== "number") return undefined
  const resetAt = typeof b.reset_at === "string" ? b.reset_at : undefined
  const end = resetAt ? Date.parse(resetAt) : NaN
  let span = MONTH_S
  if (!Number.isNaN(end)) {
    const start = new Date(end)
    start.setUTCMonth(start.getUTCMonth() - 1)
    span = Math.round((end - start.getTime()) / 1000)
  }
  return { name, used: b.usage_percentage, span, ...(resetAt ? { resetsAt: resetAt } : {}) }
}

// resolveApiKey turns a key the vibe CLI itself would resolve into the key
// this plugin serves with, when no key is pasted: MISTRAL_API_KEY
// (or VIBE_API_KEY_ENV_VAR), then $VIBE_HOME/.env, in the CLI's lookup
// order. The keyring stays the CLI's own business here.
function resolveApiKey() {
  const name = process.env.VIBE_API_KEY_ENV_VAR || "MISTRAL_API_KEY"
  if (process.env[name]) return process.env[name]
  const path = `${process.env.VIBE_HOME || `${homedir()}/.vibe`}/.env`
  let env
  try {
    env = readFileSync(path, "utf8")
  } catch {
    return null
  }
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (m?.[1] === name) return m[2].replace(/^["']|["']$/g, "")
  }
  return null
}

// the key at call time when the account is a pasted one: a pasted key
// first, then the CLI's own sources
function liveKey(auth) {
  return (auth?.type === "api" && auth.key) || resolveApiKey()
}

// ---- OIDC (the plan's own sign-in) --------------------------------------------

// the unverified claims of a JWT the platform just sent us; the platform
// verifies the token, these only carry sub/exp/nonce/aud readings
const jwt = (t) => {
  try {
    return JSON.parse(Buffer.from(String(t).split(".")[1] ?? "", "base64url").toString("utf8"))
  } catch {
    return undefined
  }
}

class OidcError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

class SignInExpired extends Error {
  constructor() {
    super("this Mistral account is signed out (OIDC re-login required); sign in again")
    this.signIn = "expired"
  }
}

// endpoints reads the issuer's discovery document; per fetchImpl, so a
// test's fake discovery is never shared with the live one
const DOC_CACHE = new WeakMap()
async function endpoints(fetchImpl) {
  let doc = DOC_CACHE.get(fetchImpl)
  if (doc) return doc
  const res = await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
  if (!res.ok) throw new OidcError(`Mistral OIDC discovery failed (HTTP ${res.status})`)
  let doc2
  try {
    doc2 = await res.json()
  } catch {}
  if (!doc2?.authorization_endpoint || !doc2?.token_endpoint) throw new OidcError("Mistral OIDC discovery is incomplete")
  doc = { authorization: doc2.authorization_endpoint, token: doc2.token_endpoint, userinfo: doc2.userinfo_endpoint }
  DOC_CACHE.set(fetchImpl, doc)
  return doc
}

// tokensOf reads a token answer: refresh is the one to keep when the
// platform sends none of its own. The ID token is what the requests carry.
function tokensOf(body, previous) {
  const access = body?.access_token
  const idToken = body?.id_token
  const claims = idToken ? jwt(idToken) : undefined
  if (typeof access !== "string" || !access || !idToken || !claims?.sub || typeof claims?.exp !== "number")
    throw new OidcError("Mistral OIDC sent no usable token bundle")
  const expiresIn = Number(body.expires_in)
  const t = {
    access,
    refresh: body.refresh_token ?? previous?.refresh ?? "",
    // an answer with no expires_in of its own is read as the hour Mistral's
    // grants last. Deriving the expiry from the ID token's exp claim
    // instead — the one clock this file and the README declare unusable,
    // see freshOidc — would hand back a bundle born already spent, and a
    // single-use refresh token spent on the very next call.
    expires: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + DEFAULT_ACCESS_MS,
    idToken,
    idExpires: claims.exp * 1000,
    subject: claims.sub,
  }
  if (!(t.refresh?.length || previous?.refresh)) throw new OidcError("Mistral OIDC sent no refresh token (offline_access)")
  return t
}

// the refresh grant (OidcService.access_tokens, scope none). Refresh tokens
// here may be single-use, like everywhere OIDC refreshes rotate.
async function refreshToken(fetchImpl, eps, refresh) {
  const res = await fetchImpl(eps.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(15000),
  })
  let body
  try {
    body = await res.json()
  } catch {}
  if (!res.ok || body?.error) {
    if (res.status === 400 && body?.error === "invalid_grant") throw new SignInExpired()
    throw new OidcError(`Mistral OIDC refresh failed (HTTP ${res.status})${body?.error ? `: ${body.error}` : ""}`)
  }
  return tokensOf(body, { refresh })
}

// freshOidc keeps the caller's wait out of a refresh another call started
// for the same refresh token; per fetchImpl, like endpoints above
const FLIGHT_CACHE = new WeakMap()

// a renewal that answers another already-spent bundle is retried this many
// times and then reported. A token endpoint that never sends a usable
// lifetime would otherwise renew forever — and burn a single-use refresh
// token on every round — until the process ran out of heap.
const MAX_RENEWALS = 3

// A renewed bundle is remembered for the rest of the process, keyed by the
// refresh token it superseded: the host re-reads its own storage for every
// request and, for OpenCode, never calls auth.refresh, and the refresh token
// that storage still holds was rotated the moment the renewal happened —
// without this, the second request would re-present the token the first
// renewal already consumed and be answered invalid_grant. Per fetchImpl, like
// the discovery and flight caches above, so a test's fake Mistral is never
// told about the live one's sessions.
const RENEWED = new WeakMap()
// one entry per renewal, so a long-lived host is capped rather than grown
const RENEWED_MAX = 64

// currentOidc is the sign-in as it stands now: the renewal that superseded
// the refresh token the host just handed back, when there is one, and the
// host's own bundle otherwise — a re-login rotates the refresh token, so its
// bundle is never found here and is the one used from then on.
function currentOidc(fetchImpl, auth) {
  if (auth?.type !== "oauth" || !auth.refresh) return auth
  return RENEWED.get(fetchImpl)?.get(auth.refresh) ?? auth
}

// remember keeps a renewal as the one that superseded the refresh token it
// was renewed from.
const remember = (fetchImpl, auth, previous) => {
  if (!previous?.refresh) return auth
  let renewed = RENEWED.get(fetchImpl)
  if (!renewed) RENEWED.set(fetchImpl, (renewed = new Map()))
  if (renewed.size >= RENEWED_MAX) renewed.delete(renewed.keys().next().value)
  renewed.set(previous.refresh, auth)
  return auth
}

// freshOidc is the sign-in ready to send with, renewed when the access
// token is nearly spent. renewed says whether this call did the renewing,
// and force renews whatever the local clock says — for the one caller that
// has proof the token is no good (a 401 on a bundle read as fresh).
//
// The staleness is read off the access token's lifetime alone, as the CLI
// reads it: the ID token's own exp claim is not a usable clock here —
// auth.mistral.ai stamps its tokens 8 hours behind UTC, so a freshly
// exchanged ID token arrives with an exp already in the past, while the
// platform serves it all the same. Trusting that claim would spend a
// refresh on every call and never send a request.
async function freshOidc(fetchImpl, auth, { renewals = 0, force = false } = {}) {
  const cur = currentOidc(fetchImpl, auth)
  if (cur?.type !== "oauth" || !cur.idToken) throw new SignInExpired()
  if (!force && !spent(cur)) return { a: cur, renewed: false }
  if (!cur.refresh) throw new SignInExpired()
  let flights = FLIGHT_CACHE.get(fetchImpl)
  if (!flights) FLIGHT_CACHE.set(fetchImpl, (flights = new Map()))
  let flight = flights.get(cur.refresh)
  if (!flight) {
    flight = (async () => {
      try {
        const eps = await endpoints(fetchImpl)
        return { ...cur, ...await refreshToken(fetchImpl, eps, cur.refresh) }
      } finally {
        flights.delete(cur.refresh)
      }
    })()
    flights.set(cur.refresh, flight)
  }
  let a
  try {
    a = await flight
  } catch (e) {
    if (e instanceof SignInExpired) throw e
    throw new OidcError(`Mistral OIDC relogin: ${e?.message ?? e}`)
  }
  // the new bundle may still be short-lived; one more renewal is honest,
  // an endless one is not
  if (spent(a)) {
    if (renewals >= MAX_RENEWALS)
      throw new OidcError("Mistral OIDC keeps sending already-expired tokens; sign in again")
    return freshOidc(fetchImpl, a, { renewals: renewals + 1 })
  }
  return { a: remember(fetchImpl, a, cur), renewed: true }
}

// spent is whether a bundle's access token is within EARLY_MS of its end.
// A bundle with no expires at all counts as spent: the local clock wrote
// that value, and only a refresh can find out.
function spent(auth) {
  const until = auth?.expires
  if (typeof until !== "number" || !Number.isFinite(until)) return true
  return until <= Date.now() + EARLY_MS
}

// the tenant headers the platform gateway routes the plan by
// (OidcTenant.headers in vibe/setup/auth/_oidc_tenant.py)
function tenantHeaders(tenant) {
  if (!tenant?.organizationId) return {}
  const headers = { "x-external-organization-id": tenant.organizationId }
  if (tenant.workspaceId) headers["x-external-workspace-id"] = tenant.workspaceId
  return headers
}

// the workspaces the ID token's user belongs to, as the CLI discovers one:
// paginated, override by organization or workspace env like TenantSelection
const TENANT_CACHE = new Map()
async function discoverTenant(fetchImpl, idToken) {
  const org = process.env.VIBE_CLI_OIDC_ORGANIZATION_ID || ""
  const ws = process.env.VIBE_CLI_OIDC_WORKSPACE_ID || ""
  if (org) return { organizationId: org, ...(ws ? { workspaceId: ws } : {}) }
  let res
  try {
    for (let page = 0; page < 10; page++) {
      res = await fetchImpl(`${AUDIENCE}/v1/users/me/workspaces?limit=100&offset=${page * 100}`, {
        headers: { authorization: `Bearer ${idToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      })
      if (res.status === 401 || res.status === 403) throw new SignInExpired()
      if (!res.ok) throw new OidcError(`Mistral workspace discovery failed (HTTP ${res.status})`)
      const body = await res.json()
      const workspaces = Array.isArray(body?.workspaces) ? body.workspaces : []
      for (const workspace of workspaces) {
        if (workspace?.id && workspace?.organization_id && (!ws || workspace.id === ws))
          return { organizationId: workspace.organization_id, workspaceId: workspace.id }
      }
      if (workspaces.length < 100) break
    }
  } catch (e) {
    if (e instanceof SignInExpired || e instanceof OidcError) throw e
    throw new OidcError(`Mistral workspace discovery failed: ${e?.message ?? e}`)
  }
  throw new OidcError("No accessible workspace found; check membership or set VIBE_CLI_OIDC_ORGANIZATION_ID")
}

// tenantFor resolves the tenant (once per identity per process) and hands
// back the headers the chat, models and usage requests carry.
async function oidcHeaders(fetchImpl, auth) {
  let cached = TENANT_CACHE.get(auth.subject)
  if (cached === undefined) cached = await discoverTenant(fetchImpl, auth.idToken)
  TENANT_CACHE.set(auth.subject, cached)
  return { authorization: `Bearer ${auth.idToken}`, ...tenantHeaders(cached) }
}

// ---- the browser sign-in: authorization-code PKCE on the loopback --------------

const pkcePair = () => {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

// exchangeCode trades the callback's code for the token bundle, with the
// checks the CLI makes (audience, subject, nonce).
async function exchangeCode(fetchImpl, params) {
  const eps = await endpoints(fetchImpl)
  const res = await fetchImpl(eps.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      // the redirect the browser was sent to, named back exactly as it was
      // sent: an IdP binds the code to the redirect_uri of the request that
      // asked for it, and answers invalid_grant on a mismatch
      redirect_uri: params.redirectUri ?? redirectUriOf(),
      client_id: CLIENT_ID,
      code_verifier: params.verifier,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  })
  let body
  try {
    body = await res.json()
  } catch {}
  if (!res.ok || body?.error) throw new OidcError(`Mistral OIDC exchange failed (HTTP ${res.status})${body?.error ? `: ${body.error}` : ""}`)
  const t = tokensOf(body)
  const claims = jwt(t.idToken)
  if (claims.iss !== ISSUER || !(claims.aud === CLIENT_ID || (Array.isArray(claims.aud) && claims.aud.includes(CLIENT_ID))))
    throw new OidcError("Mistral OIDC token bundle is not this CLI registration's")
  if (params.nonce && claims.nonce !== params.nonce) throw new OidcError("Mistral OIDC nonce mismatch")
  const email = typeof claims.email === "string" ? claims.email : undefined
  return { ...t, ...(email ? { email } : {}) }
}

// redirectUriOf is the loopback the browser is sent to: the CLI's own fixed
// port, or the override for when something else already holds it. The
// authorization request, the listener and the token request all read it
// from here, so they can never disagree.
const redirectUriOf = () => process.env.VIBE_CLI_OIDC_REDIRECT_URI || REDIRECT_URI

// the authorization URL the browser opens (OidcService._complete's shape)
async function authorizationUrl(fetchImpl, { challenge, state, nonce, redirectUri }) {
  const eps = await endpoints(fetchImpl)
  const url = new URL(eps.authorization)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    audience: AUDIENCE,
    redirect_uri: redirectUri ?? redirectUriOf(),
    scope: SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()
  return url.toString()
}

// callbackServer answers one GET on the loopback and resolves the code.
// The CLI's redirect URI is a fixed port; a vibe CLI running a sign-in at
// the same moment squats it, and this says so instead of hanging.
function callbackServer(redirectUri, state) {
  const show = (res, title, body) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body><h1>Mistral Vibe sign-in</h1><p>${body}</p></body>`)
  }
  return new Promise((resolve, reject) => {
    const url = new URL(redirectUri)
    let settled = false
    let timer
    // the port is given back on every way out, the failing ones included:
    // a sign-in that keeps the socket bound makes the NEXT one fail with
    // EADDRINUSE and blame the CLI for it
    const release = () => {
      clearTimeout(timer)
      try {
        if (server.listening) {
          server.closeAllConnections?.()
          server.close(() => {})
        }
      } catch {}
    }
    const fail = (e) => {
      if (settled) return
      settled = true
      release()
      reject(e)
    }
    const server = createServer((req, res) => {
      const q = Object.fromEntries(new URL(req.url, `http://${req.headers.host ?? url.host}`).searchParams)
      if (q.error) {
        show(res, "denied", "The sign-in was turned down in the browser.")
        fail(new OidcError(q.error_description || q.error))
      } else if (q.state !== state) {
        show(res, "failed", "The browser's answer does not match this sign-in (state).")
        fail(new OidcError("Mistral OIDC state mismatch"))
      } else if (q.code) {
        show(res, "done", "Signed in. You can return to the terminal.")
        settled = true
        resolve({ code: q.code, close: release })
      } else {
        show(res, "waiting", "No sign-in code arrived; close this tab and try again.")
      }
    })
    server.on("error", (e) =>
      fail(new OidcError(
        `${redirectUri} could not be listened on (${e.code ?? e.message}); close the vibe CLI or another sign-in using that port, or set VIBE_CLI_OIDC_REDIRECT_URI`
      ))
    )
    server.listen(Number(url.port), url.hostname)
    timer = setTimeout(() => fail(new OidcError("the browser sign-in expired (5 minutes)")), 5 * 60 * 1000)
    timer.unref?.()
  })
}

function createPlugin({ fetchImpl = globalThis.fetch } = {}) {
  return {
    config: async (cfg) => {
      // a cfg the host already filled in — a second run of the hook, or a
      // user's own block — is completed, not left as it was: a partially
      // specified provider cannot build the SDK, and a stale model list
      // from an older version of this plugin never repairs itself. A cfg
      // that cannot be written at all is left alone rather than thrown out
      // of the hook.
      try {
        cfg.provider ??= {}
        const block = (cfg.provider[ID] ??= {})
        block.name ??= "Mistral Vibe"
        block.npm ??= "@ai-sdk/openai-compatible" // chat completions
        block.api ??= BASE
        block.models = { ...rowsFor(BOOT.map((m) => m.id)), ...block.models }
      } catch {}
    },

    auth: {
      provider: ID,
      methods: [
        {
          type: "oauth",
          label: "Mistral Vibe plan (browser sign in)",
          async authorize() {
            const { verifier, challenge } = pkcePair()
            const state = randomBytes(16).toString("base64url")
            const nonce = randomBytes(16).toString("base64url")
            const redirectUri = redirectUriOf()
            const url = await authorizationUrl(fetchImpl, { challenge, state, nonce, redirectUri })
            const waiting = callbackServer(redirectUri, state)
            return {
              url,
              instructions: "Sign in to Mistral in the browser and approve; this finishes by itself.",
              method: "auto",
              async callback() {
                try {
                  const done = await waiting
                  try {
                    const t = await exchangeCode(fetchImpl, { code: done.code, verifier, nonce, redirectUri })
                    return {
                      type: "success",
                      access: t.access,
                      refresh: t.refresh,
                      expires: t.expires,
                      idToken: t.idToken,
                      idExpires: t.idExpires,
                      subject: t.subject,
                      accountId: t.email || t.subject,
                      ...(t.email ? { email: t.email } : {}),
                    }
                  } finally {
                    done.close()
                  }
                } catch (e) {
                  return { type: "failed", error: `Mistral sign-in: ${e?.message ?? e}` }
                }
              },
            }
          },
        },
        { type: "api", label: "Mistral API key (plain account, not the plan)", placeholder: "…" },
      ],
      // magpie renews the sign-in LEAD_MS before its end, once for the
      // account, before its requests, models and usage ask for it; the
      // check before each request below stays for OpenCode, which
      // doesn't call this
      refreshLead: LEAD_MS,
      async refresh(auth) {
        const cur = currentOidc(fetchImpl, auth)
        if (cur?.type !== "oauth" || !cur.idToken) return undefined
        // the access token's end, LEAD_MS out — the ID token's exp claim is
        // 8 hours behind UTC and says nothing usable (see freshOidc)
        if (!spent(cur) && (cur.expires ?? 0) > Date.now() + LEAD_MS) return undefined
        try {
          const { a } = await freshOidc(fetchImpl, cur)
          return a
        } catch {
          return undefined
        }
      },
      async loader(getAuth) {
        const auth = currentOidc(fetchImpl, await getAuth())
        // an OIDC account whose stored bundle lost its ID token is a broken
        // sign-in, not a pasted key: the env-resolved platform key would
        // spend API balance instead of the plan's quota, and would say
        // nothing about the sign-in that needs redoing
        if (auth?.type === "oauth" && !auth.idToken) throw new SignInExpired()
        if (auth?.type === "oauth") {
          return {
            baseURL: BASE,
            apiKey: OAUTH_KEY,
            async fetch(input, init) {
              const req = input instanceof Request ? input : null
              // the request goes out as it was handed to us: a Request's
              // method, body and signal belong to the turn, and dropping
              // them turns a chat POST into a bodiless GET. The caller's
              // own signal wins when it has one; otherwise the turn gets a
              // ceiling of our own, and no redirect is followed with the
              // plan's credentials in hand.
              const policy = {
                signal: init?.signal ?? req?.signal ?? AbortSignal.timeout(TURN_MS),
                redirect: init?.redirect ?? "error",
              }
              const send = async (a) => {
                const headers = new Headers(init?.headers ?? req?.headers)
                for (const [k, v] of Object.entries(await oidcHeaders(fetchImpl, a))) headers.set(k, v)
                return fetchImpl(
                  req ? new Request(req, { ...init, headers, ...policy }) : input,
                  req ? undefined : { ...init, headers, ...policy },
                  "chat",
                )
              }
              let res
              try {
                const { a, renewed } = await freshOidc(fetchImpl, auth)
                res = await send(a)
                if (res.status === 401 && !renewed) {
                  // turned away before its end: the platform refused a token
                  // the local clock called fresh, so renew once from the
                  // bundle this call holds — never from the stored one, whose
                  // refresh token a renewal has already consumed — and then
                  // no more, so one turn spends at most one refresh token
                  const n = await freshOidc(fetchImpl, a, { force: true })
                  res = await send(n.a)
                }
              } catch (e) {
                return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: e?.message ?? String(e) } }), {
                  status: 502,
                  statusText: "Bad Gateway",
                  headers: { "content-type": "application/json" },
                })
              }
              return res
            },
          }
        }
        const key = liveKey(auth)
        if (!key) return {}
        return { baseURL: BASE, apiKey: key }
      },
      // the sign-in state first — a refused credential marks the account
      // for sign-in, an unreachable table says nothing about it — then the
      // plan's allowances beside it, as a read that says nothing about the
      // sign-in either way.
      async usage(getAuth) {
        const auth = currentOidc(fetchImpl, await getAuth())
        if (auth?.type !== "oauth" && !liveKey(auth))
          return { error: "not signed in: use Mistral Vibe plan (browser sign in)", windows: [] }
        try {
          if (auth?.type === "oauth") {
            const { a } = await freshOidc(fetchImpl, auth)
            const headers = await oidcHeaders(fetchImpl, a)
            // the tables are the sign-in's own proof it still works; a
            // failure here is reported beside the identity, not instead
            // of it, and only a refusal marks the account for sign-in
            let error
            let signIn
            try {
              const { ids } = await modelTable(fetchImpl, headers)
              if (!ids.length) error = "Mistral answered no model list for this account"
            } catch (e) {
              if (!(e instanceof Refused)) throw e
              error = "Mistral refused this sign-in; sign in again"
              signIn = "expired"
            }
            const quota = await billingOf(fetchImpl, headers).catch(() => null)
            return {
              user: a.email || a.subject,
              ...(quota?.plan ? { plan: quota.plan } : {}),
              ...(error ? { error } : {}),
              ...(signIn ? { signIn } : {}),
              windows: quota?.windows ?? [],
            }
          }
          const headers = bearerOf(liveKey(auth))
          const { ids } = await modelTable(fetchImpl, headers)
          if (!ids.length) return { error: "Mistral answered no model list for this key", windows: [] }
          const quota = await billingOf(fetchImpl, headers).catch(() => null)
          return { ...(quota?.plan ? { plan: quota.plan } : {}), windows: quota?.windows ?? [] }
        } catch (e) {
          if (e instanceof Refused)
            return { error: auth?.type === "oauth" ? "Mistral refused this sign-in; sign in again" : "Mistral refused this key; paste a fresh one", signIn: "expired", windows: [] }
          if (e instanceof SignInExpired) return { error: e.message, signIn: "expired", windows: [] }
          return { error: `Mistral unreachable: ${e?.cause?.code || e?.message || "network error"}`, ...(e?.signIn ? { signIn: e.signIn } : {}), windows: [] }
        }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const cur = currentOidc(fetchImpl, auth)
        // the tables are read with the credential's own headers: an OIDC
        // session's token beside the workspace headers the gateway wants
        // (/v1/models answers 401 without them), a pasted key's bearer. An
        // OIDC account without an ID token is a broken sign-in, not the
        // pasted-key path.
        let headers
        if (cur?.type === "oauth") {
          if (!cur.idToken) throw new SignInExpired()
          try {
            const { a } = await freshOidc(fetchImpl, cur)
            headers = await oidcHeaders(fetchImpl, a)
          } catch (e) {
            if (e?.signIn === "expired") throw e
            return provider.models
          }
        } else {
          const key = liveKey(cur)
          if (!key) return provider.models
          headers = bearerOf(key)
        }
        let table
        try {
          table = await modelTable(fetchImpl, headers)
        } catch (e) {
          if (!(e instanceof Refused)) return provider.models
          throw Object.assign(
            new Error(cur?.type === "oauth" ? "Mistral refused this sign-in; sign in again" : `Mistral refused this key (HTTP ${e.status ?? 401}); paste a fresh one`),
            { signIn: "expired" },
          )
        }
        if (!table.ids.length) return provider.models
        return rowsFor(table.ids, table.byId)
      },
    },
  }
}

// magpie calls every exported function as a plugin with the host pair; the
// test-fetch factory stays on createPlugin, _internal's.
export const VibePlugin = async () => createPlugin()
export const _internal = {
  createPlugin, row, rowsFor, resolveApiKey, liveKey, modelTable, tableOf, bearerOf, Refused, billingOf, budgetWindow,
  BOOT, BASE, ID, ISSUER, CLIENT_ID, AUDIENCE, REDIRECT_URI, SCOPE, OAUTH_KEY, LEAD_MS, EARLY_MS,
  endpoints, tokensOf, refreshToken, freshOidc, spent, oidcHeaders, discoverTenant,
  tenantHeaders, exchangeCode, authorizationUrl, pkcePair, jwt, OidcError, SignInExpired,
  callbackServer, redirectUriOf, currentOidc, MAX_RENEWALS, DEFAULT_ACCESS_MS, TURN_MS,
}
