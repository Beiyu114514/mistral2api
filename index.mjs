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
// Verified end to end on a FREE plan account on 2026-11-06, including the
// first OIDC turn, workspace discovery, model tables, billing reads and the
// single-use refresh-token chain across a restart.

import { constants as cryptoConstants, createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto"
import { createServer } from "node:http"
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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
const TURN_ENV_MS = Number(process.env.VIBE_TURN_TIMEOUT_MS)
const TURN_MS = Number.isFinite(TURN_ENV_MS) && TURN_ENV_MS > 0 && TURN_ENV_MS <= 2_147_483_647
  ? TURN_ENV_MS
  : 5 * 60 * 1000
// the length of a monthly allowance's cycle, for a window whose reset
// cannot be read
const MONTH_S = 30 * 24 * 3600

// Models the plan does not serve through chat completions. The catalog can
// mark them directly; this catches the account list, which carries ids only.
const NON_CHAT_MODEL = /(?:^|[-_])(embed|embedding|ocr|moderation|guard|rerank|transcribe|transcription|tts|speech)(?:[-_]|$)/i

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

const BOOT_IDS = new Set(BOOT.map((m) => m.id))
const CATALOG = new WeakMap()

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

// Whether a table entry can serve chat completions. A catalog entry that
// says completion_chat is false is never exposed, and the account table,
// which has ids but no capabilities, is filtered by the known non-chat
// families. FIM stays: the plan serves mistral-code-fim-latest as a chat
// model even though its name carries the FIM marker.
const isChatModel = (id, entry) =>
  entry?.capabilities?.completion_chat !== false && !NON_CHAT_MODEL.test(id)

// Refused is a model table the credential may not read: the sign-in is
// what needs fixing, not the list. The status is kept so a 403 is not
// reported as a 401 to the user.
class Refused extends Error {
  constructor(url, status) {
    super(`${url} (HTTP ${status})`)
    this.status = status
  }
}

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
  if (res.status === 401 || res.status === 403) throw new Refused(url, res.status)
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
async function modelTable(fetchImpl, headers, { plan = false } = {}) {
  const [catalog, account] = await Promise.all([
    tableOf(fetchImpl, `${BASE}/model-catalog?surface=vibe-code`, headers),
    tableOf(fetchImpl, `${BASE}/models`, headers),
  ])
  const catalogModels = Array.isArray(catalog?.models)
    ? catalog.models.filter((m) => typeof m?.id === "string" && m.id)
    : []
  if (plan && catalogModels.length) CATALOG.set(fetchImpl, catalogModels)
  const allowModels = plan && !catalogModels.length ? CATALOG.get(fetchImpl) ?? [] : catalogModels
  const allowIds = new Set(allowModels.filter((m) => isChatModel(m.id, m)).map((m) => m.id))
  const catalogById = new Map(catalogModels.map((m) => [m.id, m]))
  const entries = catalogModels.filter((m) => isChatModel(m.id, m))
  const byId = new Map(entries.map((m) => [m.id, m]))
  // When the plan catalog is available it is the plan's allowlist. The
  // account table still supplies newer ids, but a platform-wide model the
  // plan cannot spend on (devstral-*, mistral-large-latest) must not become
  // selectable just because the account endpoint lists it. The bootstrap ids
  // are the ones verified against a real plan account. An unavailable
  // catalog leaves the account table as the authority.
  const restrictToPlan = plan && allowIds.size > 0
  const accountIds = Array.isArray(account?.data)
    ? account.data
      .map((m) => m?.id)
      .filter((id) =>
        typeof id === "string" && id &&
        isChatModel(id, catalogById.get(id)) &&
        (!restrictToPlan || byId.has(id) || BOOT_IDS.has(id) || allowIds.has(id)))
    : []
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
    const day = start.getUTCDate()
    // setUTCMonth alone rolls 31 March back to 3 March; pin the day first
    // so a month-end cycle becomes 28/29/30/31 days as appropriate.
    start.setUTCDate(1)
    start.setUTCMonth(start.getUTCMonth() - 1)
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
    start.setUTCDate(Math.min(day, lastDay))
    span = Math.round((end - start.getTime()) / 1000)
  }
  return { name, used: b.usage_percentage, span, ...(!Number.isNaN(end) ? { resetsAt: resetAt } : {}) }
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
  for (const raw of env.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "").trim()
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m?.[1] !== name) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1)
    return value || null
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
  if (doc2?.issuer && doc2.issuer !== ISSUER) throw new OidcError("Mistral OIDC discovery names another issuer")
  if (!doc2?.authorization_endpoint || !doc2?.token_endpoint) throw new OidcError("Mistral OIDC discovery is incomplete")
  if (doc2.issuer && !doc2.jwks_uri) throw new OidcError("Mistral OIDC discovery has no JWKS URL")
  if (doc2.jwks_uri) {
    let jwks
    try {
      jwks = new URL(doc2.jwks_uri)
    } catch {
      throw new OidcError("Mistral OIDC discovery has an invalid JWKS URL")
    }
    if (jwks.protocol !== "https:") throw new OidcError("Mistral OIDC discovery has a non-HTTPS JWKS URL")
  }
  doc = {
    authorization: doc2.authorization_endpoint,
    token: doc2.token_endpoint,
    jwks: doc2.jwks_uri,
    userinfo: doc2.userinfo_endpoint,
  }
  DOC_CACHE.set(fetchImpl, doc)
  return doc
}

const ID_AUDIENCE = (claims) =>
  claims?.aud === CLIENT_ID || (Array.isArray(claims?.aud) && claims.aud.includes(CLIENT_ID))

const checkIdClaims = (claims) => {
  if (claims?.iss !== ISSUER || !ID_AUDIENCE(claims))
    throw new OidcError("Mistral OIDC token bundle is not this CLI registration's")
  return claims
}

// Discovery is served by the issuer over TLS. When it advertises a JWKS, the
// ID token's signature is checked as well as its claims; tests and non-OIDC
// callers that provide only endpoint URLs skip this optional layer.
const JWKS = new WeakMap()
const JWKS_TTL_MS = 10 * 60 * 1000
const JWT_HASH = new Map([
  ["RS256", "sha256"], ["RS384", "sha384"], ["RS512", "sha512"],
  ["PS256", "sha256"], ["PS384", "sha384"], ["PS512", "sha512"],
  ["ES256", "sha256"], ["ES384", "sha384"], ["ES512", "sha512"],
])

async function jwksOf(fetchImpl, eps, force = false) {
  if (!eps.jwks) return []
  const cached = JWKS.get(fetchImpl)
  if (!force && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys
  let res
  try {
    res = await fetchImpl(eps.jwks, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
  } catch (e) {
    throw new OidcError(`Mistral OIDC JWKS fetch failed: ${e?.message ?? e}`)
  }
  if (!res.ok) throw new OidcError(`Mistral OIDC JWKS fetch failed (HTTP ${res.status})`)
  let body
  try {
    body = await res.json()
  } catch {}
  const keys = Array.isArray(body?.keys)
    ? body.keys.filter((key) => key && typeof key === "object" && typeof key.kty === "string")
    : []
  if (!keys.length) throw new OidcError("Mistral OIDC JWKS has no usable keys")
  JWKS.set(fetchImpl, { keys, at: Date.now() })
  return keys
}

async function verifyIdToken(fetchImpl, eps, token) {
  if (!eps.jwks) return
  const parts = String(token).split(".")
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2])
    throw new OidcError("Mistral OIDC sent a malformed ID token")
  let header
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
  } catch {}
  if (!header || !JWT_HASH.has(header.alg))
    throw new OidcError("Mistral OIDC used an unsupported ID-token signing algorithm")
  const candidates = (keys) => keys.filter((key) =>
    (!header.kid || key.kid === header.kid) &&
    (!key.use || key.use === "sig") &&
    (!key.alg || key.alg === header.alg))
  let keys = await jwksOf(fetchImpl, eps)
  let matches = candidates(keys)
  if (!matches.length) {
    // key rotation: one forced read is enough
    keys = await jwksOf(fetchImpl, eps, true)
    matches = candidates(keys)
  }
  if (!matches.length) throw new OidcError("Mistral OIDC JWKS has no matching signing key")
  const data = Buffer.from(`${parts[0]}.${parts[1]}`)
  const signature = Buffer.from(parts[2], "base64url")
  const hash = JWT_HASH.get(header.alg)
  let ok = false
  for (const jwk of matches) {
    let key
    try {
      key = createPublicKey({ key: jwk, format: "jwk" })
    } catch {
      continue
    }
    try {
      if (header.alg.startsWith("RS"))
        ok = verifySignature(hash, data, key, signature)
      else if (header.alg.startsWith("PS"))
        ok = verifySignature(hash, data, {
          key,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
        }, signature)
      else if (header.alg.startsWith("ES"))
        ok = verifySignature(hash, data, { key, dsaEncoding: "ieee-p1363" }, signature)
    } catch {}
    if (ok) break
  }
  if (!ok) throw new OidcError("Mistral OIDC ID-token signature did not verify")
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
  // Warm and validate the JWKS before spending the single-use refresh token;
  // a JWKS outage must not leave the session with a token it cannot persist.
  if (eps.jwks) await jwksOf(fetchImpl, eps)
  const res = await fetchImpl(eps.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
  let body
  try {
    body = await res.json()
  } catch {}
  if (!res.ok || body?.error) {
    if (res.status === 400 && body?.error === "invalid_grant") throw new SignInExpired()
    throw new OidcError(`Mistral OIDC refresh failed (HTTP ${res.status})${body?.error ? `: ${body.error}` : ""}`)
  }
  const t = tokensOf(body, { refresh })
  checkIdClaims(jwt(t.idToken))
  await verifyIdToken(fetchImpl, eps, t.idToken)
  return t
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
//
// Every key that still resolves to the superseded bundle is re-pointed at the
// renewal, not only the token it was renewed from: the host re-reads its own
// storage on every request, and that storage still holds the bundle the FIRST
// renewal superseded — so the key the host looks up has to track the newest
// bundle all the way down a chain of renewals, or it resolves to a stale one
// whose refresh token a later renewal already consumed. What is left is one
// key per bundle: the tokens spent on the way are never looked up again once
// the host's own key resolves, and leaving them would let the cap below evict
// the one key that is looked up.
const remember = (fetchImpl, auth, previous) => {
  if (!previous?.refresh) return auth
  let renewed = RENEWED.get(fetchImpl)
  if (!renewed) RENEWED.set(fetchImpl, (renewed = new Map()))
  for (const [k, v] of renewed) if (v === previous) renewed.set(k, auth)
  renewed.set(previous.refresh, auth)
  const kept = new Set()
  for (const [k, v] of [...renewed]) {
    if (kept.has(v)) renewed.delete(k)
    else kept.add(v)
  }
  if (renewed.size >= RENEWED_MAX) renewed.delete(renewed.keys().next().value)
  return auth
}

// ---- the plugin's own session file -------------------------------------------

// OpenCode gives a plugin no way to write its account storage back, and never
// calls auth.refresh, so a renewal used to live only in this process: the
// host's next request presented the sign-in's refresh token, which the first
// renewal had already consumed, and a restart took every renewal with it. The
// renewed bundle is therefore kept in a file of the plugin's own — the CLI's
// keyring stays the CLI's, this is this sign-in's own session — and read back
// whenever the host's bundle is no longer the newest one. magpie renews
// through auth.refresh and keeps what it returns, so there the file is the
// safety net rather than the only copy.
const sessionPath = () =>
  process.env.VIBE_SESSION_FILE ||
  `${process.env.VIBE_HOME || `${homedir()}/.vibe`}/.opencode-vibe-session.json`

// the file's bundle, read once per process and kept current by every renewal;
// per fetchImpl, like the caches above, so a test's fake Mistral is never told
// about the live one's sessions
const SESSIONS = new WeakMap()

const saveSession = (fetchImpl, auth) => {
  // A token bundle from exchangeCode has no type yet; OAuth is the only
  // kind that is ever written here, so normalize instead of dropping the
  // first sign-in on the floor.
  if (!auth || (auth.type && auth.type !== "oauth") || !auth.access || !auth.refresh || !auth.idToken) return
  const bundle = auth.type === "oauth" ? auth : { ...auth, type: "oauth" }
  SESSIONS.set(fetchImpl, bundle)
  const path = sessionPath()
  try {
    // the default path lives under ~/.vibe, which need not exist yet when
    // someone signs in without having installed the vibe CLI
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  } catch {}
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  try {
    // written beside the target and moved into place: two hosts (opencode and
    // magpie) may renew at once, and a reader must never see half a file. The
    // random suffix and wx keep an old or planted temp file out of the way.
    writeFileSync(tmp, JSON.stringify({
      access: bundle.access,
      refresh: bundle.refresh,
      idToken: bundle.idToken,
      expires: bundle.expires,
      idExpires: bundle.idExpires,
      subject: bundle.subject,
      email: bundle.email,
    }), { mode: 0o600, flag: "wx" })
    renameSync(tmp, path)
  } catch {
    // a session file that cannot be written leaves the sign-in where it was
    // before the file existed: renewals still work for this process, and
    // nothing about the request path changes
    try {
      rmSync(tmp, { force: true })
    } catch {}
  }
}

const loadSession = (fetchImpl, { force = false } = {}) => {
  const cached = SESSIONS.get(fetchImpl)
  // a cached bundle that has run out is read again rather than kept: another
  // process may have renewed the chain past it by then, and its refresh token
  // is spent the moment that happened
  if (!force && cached && !spent(cached)) return cached
  let found = null
  try {
    const t = JSON.parse(readFileSync(sessionPath(), "utf8"))
    if (t?.access && t?.refresh) found = { ...t, type: "oauth" }
  } catch {}
  if (found) {
    SESSIONS.set(fetchImpl, found)
    return found
  }
  // a forced read is used to look past this process's cache. If the file is
  // gone or unreadable, the in-memory bundle is still the best one we have.
  if (force) return cached ?? null
  SESSIONS.set(fetchImpl, null)
  return null
}

// newerSession is the session file's bundle when it is the newer of the two:
// a renewal in an earlier run rotated the refresh token the host still holds,
// so the file's is the one that can still be renewed. A sign-in done after
// that renewal is newer still and wins, so a re-login is never shadowed by
// the file — and never answered with another account's session either.
const newerSession = (fetchImpl, auth, options) => {
  if (auth?.type !== "oauth") return auth
  const stored = loadSession(fetchImpl, options)
  if (stored?.type !== "oauth" || !stored.idToken) return auth
  const subject = auth.subject ?? jwt(auth.idToken)?.sub
  // an unknown subject is not evidence that the file belongs to this account
  if (stored.subject && !subject) return auth
  if (stored.subject && subject && stored.subject !== subject) return auth
  if ((stored.expires ?? 0) <= (auth.expires ?? 0)) return auth
  return remember(fetchImpl, stored, auth)
}

// The refresh token is single-use. FLIGHT_CACHE only coalesces callers in
// this process, so a small on-disk lease keeps opencode and magpie (or two
// copies of either) from presenting the same token at the same time. A
// holder never keeps it longer than the token endpoint's own 15s timeout.
const LOCK_WAIT_MS = 25_000
const LOCK_STALE_MS = 20_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withSessionLock(fn) {
  const path = sessionPath()
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  } catch {}
  const lock = `${path}.lock`
  const owner = join(lock, "owner")
  const token = `${process.pid}.${randomBytes(8).toString("hex")}`
  const deadline = Date.now() + LOCK_WAIT_MS
  let held = false
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 })
    } catch (e) {
      // an unwritable directory must not make the request path worse than it
      // was before the file existed; renewals still work in this process
      if (e?.code !== "EEXIST") return fn()
      let stale = false
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS
      } catch {}
      if (stale) {
        // Rename first: only one waiter can win the stale takeover, so two
        // waiters cannot both remove a lock and then both acquire a new one.
        const retired = `${lock}.stale.${token}`
        try { rmSync(retired, { recursive: true, force: true }) } catch {}
        try { renameSync(lock, retired) } catch { continue }
        try { rmSync(retired, { recursive: true, force: true }) } catch {}
        continue
      }
      if (Date.now() >= deadline)
        throw new OidcError("timed out waiting for another Mistral sign-in renewal")
      await sleep(25 + Math.floor(Math.random() * 50))
      continue
    }
    try {
      writeFileSync(owner, token, { mode: 0o600, flag: "wx" })
      held = true
      break
    } catch {
      try { rmSync(lock, { recursive: true, force: true }) } catch {}
      return fn()
    }
  }
  try {
    return await fn()
  } finally {
    if (held) {
      try {
        if (readFileSync(owner, "utf8") === token) rmSync(lock, { recursive: true, force: true })
      } catch {}
    }
  }
}

// ---- the request body Mistral's schema takes --------------------------------
//
// Mistral validates a chat completions body against a closed schema
// (additionalProperties: false): a field it does not name is not ignored
// but refused, and the whole request is turned away with 422
// "extra_forbidden". An OpenAI-compatible client may send any field it
// likes, and the hosts in front of this provider forward them as written —
// magpie's gateway relays a Chat client's body to a plugin provider
// untouched, and the Mistral-specific rewrites it has are keyed on the
// provider's host being api.mistral.ai, which a plugin provider's never is.
// So the body is made to fit here, once, before it leaves.
//
// Every rule below was sent to a real plan account on 2026-11-06 and
// answered with a 422 naming the field it touches, except function_call:
// it is the legacy companion of the dropped functions field and goes with
// it. Fields Mistral answers 200 to — stream_options, metadata, n,
// modalities, parallel_tool_calls, prediction, an empty tools list, a
// tool_choice with no tools, strict on a function tool — are left exactly
// as they came.

// OpenAI's own fields Mistral has no place for. `user` is the one a host
// forwards as written: LobeChat sends a stable "user_…" id on every turn,
// and every turn was refused with extra_forbidden @ body.user.
const MISTRAL_UNNAMED = ["user", "verbosity", "store", "web_search_options", "functions", "function_call", "safety_identifier", "reasoning"]
// Mistral has service_tier but answers only these two; OpenAI's priority,
// default, flex, scale and batch are all refused, so a value it does not
// answer is dropped rather than guessed at.
const MISTRAL_TIERS = ["auto", "standard_only"]
// the ceiling on temperature in Mistral's schema
const MISTRAL_TEMP_MAX = 1.5
// The fields each message role names. Mistral's message schemas are closed
// and narrower than OpenAI's: a role is one of these four — OpenAI's
// `developer` is refused as union_tag_invalid — and each names its own
// fields, so an assistant turn's `refusal` or a tool result's `is_error` is
// refused just as a top-level field is.
const MESSAGE_FIELDS = {
  system: ["role", "content"],
  user: ["role", "content"],
  assistant: ["role", "content", "tool_calls", "prefix"],
  tool: ["role", "content", "tool_call_id", "name"],
}
// The fields clients send an assistant turn's thinking back in. Mistral
// refuses every one of them, and takes the thought as a thinking content
// part instead — so it stays in the context rather than being dropped.
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"]

// reasoningText is the thinking a message carries in the fields OpenAI's
// clients use for it, as one text. reasoning_details holds objects with
// their own text; reasoning may be a string, such a list, or an object
// with none of it.
function reasoningText(m) {
  let text = ""
  for (const f of REASONING_FIELDS) {
    const v = m[f]
    if (typeof v === "string") text += v
    else if (Array.isArray(v)) {
      for (const e of v) {
        if (typeof e === "string") text += e
        else if (e && typeof e === "object" && typeof e.text === "string") text += e.text
      }
    } else if (v && typeof v === "object" && typeof v.text === "string") text += v.text
  }
  return text
}

// withThinking puts think ahead of content as the thinking part Mistral
// returns it in. A content that is a string becomes the part list Mistral
// wants; one that is already a list takes the part first; a turn with
// nothing in it has the thinking alone.
function withThinking(content, think) {
  const part = { type: "thinking", thinking: [{ type: "text", text: think }] }
  if (Array.isArray(content)) return [part, ...content]
  if (typeof content === "string" && content !== "") return [part, { type: "text", text: content }]
  return [part]
}

// chatMessage is one message with only the fields its role names, and an
// assistant turn's thinking where Mistral takes it. A message whose role is
// none of the four is answered as it came: Mistral's own refusal says more
// about it than a guess would.
function chatMessage(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return m
  const role = m.role === "developer" ? "system" : m.role
  const fields = Object.prototype.hasOwnProperty.call(MESSAGE_FIELDS, role) ? MESSAGE_FIELDS[role] : undefined
  if (!fields) return m
  const out = { role }
  for (const f of fields) if (f !== "role" && f in m) out[f] = m[f]
  let changed = role !== m.role
  for (const k of Object.keys(m)) if (!fields.includes(k)) changed = true
  if (role === "assistant") {
    const think = reasoningText(m)
    if (think) {
      out.content = withThinking(out.content, think)
      changed = true
    }
  }
  return changed ? out : m
}

// chatBody is body with every field Mistral's chat completions schema does
// not name taken out or renamed. changed says whether anything was: a body
// Mistral takes as it comes is sent in its own bytes rather than rebuilt,
// so a JSON round trip never gets the chance to alter a number in it.
function chatBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, changed: false }
  const out = { ...body }
  let changed = false
  for (const f of MISTRAL_UNNAMED) {
    if (f in out) {
      delete out[f]
      changed = true
    }
  }
  // seed is Mistral's random_seed, and the AI SDK sends seed. The pair
  // would be one setting spelled twice, of which Mistral refuses the
  // OpenAI one.
  if ("seed" in out) {
    if (out.random_seed == null) out.random_seed = out.seed
    delete out.seed
    changed = true
  }
  // Mistral takes either spelling of the reply limit but never both.
  if ("max_completion_tokens" in out) {
    if (out.max_tokens == null) out.max_tokens = out.max_completion_tokens
    delete out.max_completion_tokens
    changed = true
  }
  if (out.service_tier != null && !MISTRAL_TIERS.includes(out.service_tier)) {
    delete out.service_tier
    changed = true
  }
  if (typeof out.temperature === "number" && out.temperature > MISTRAL_TEMP_MAX) {
    out.temperature = MISTRAL_TEMP_MAX
    changed = true
  }
  if (Array.isArray(out.messages)) {
    const messages = out.messages.map(chatMessage)
    if (messages.some((m, i) => m !== out.messages[i])) {
      out.messages = messages
      changed = true
    }
  }
  return { body: out, changed }
}

// A body past this size is not parsed or reshaped: reshaping it holds the
// whole of it twice, and a stream that large is refused before it can be
// buffered.
const MAX_SHAPED_BYTES = 32 * 1024 * 1024

// chatURL is whether u asks for chat completions, the only request whose
// body Mistral's closed schema can refuse.
const chatURL = (u) => {
  try {
    return new URL(u).pathname.endsWith("/chat/completions")
  } catch {
    return false
  }
}

// shapedBody is body as a chat completions request goes out: the same value
// when it needs nothing — not a chat completions POST, not JSON, a body that
// does not parse, or one that parses to nothing Mistral refuses — and the
// reshaped text when it carries a field Mistral's schema does not name.
// Keeping the caller's own value on the unchanged path means the request
// leaves in the bytes it arrived in.
const shapedBody = (body, url, contentType, method) => {
  if (method !== "POST" || !chatURL(url)) return body
  if (contentType && !/^application\/(?:[^;]+\+)?json\b/i.test(contentType)) return body
  let text
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > MAX_SHAPED_BYTES) return body
    text = body
  }
  else {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_SHAPED_BYTES) return body
    try {
      text = new TextDecoder("utf8", { fatal: true }).decode(bytes)
    } catch {
      return body
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return body
  }
  const { body: out, changed } = chatBody(parsed)
  return changed ? JSON.stringify(out) : body
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
  const cur = newerSession(fetchImpl, currentOidc(fetchImpl, auth))
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
        // Keep a possibly slow JWKS read outside the renewal lease; the token
        // request itself remains the only work that must be serialised.
        if (eps.jwks) await jwksOf(fetchImpl, eps)
        // Discovery is cached and harmless; the lease is held only around the
        // token request so two hosts cannot spend the same single-use token.
        return await withSessionLock(async () => {
          const latest = newerSession(fetchImpl, cur, { force: true })
          let base = latest?.type === "oauth" && latest.idToken ? latest : cur
          if (base.subject && cur.subject && base.subject !== cur.subject) base = cur
          // another process may already have advanced the chain while this
          // request waited for the lease
          if (base.refresh !== cur.refresh && !spent(base)) return base
          if (!force && !spent(base)) return base
          if (!base.refresh) throw new SignInExpired()
          try {
            const renewed = { ...base, ...await refreshToken(fetchImpl, eps, base.refresh) }
            // the renewal is the session from here on, in this process and
            // past its end: the host's storage still holds what it was
            // renewed from
            saveSession(fetchImpl, renewed)
            return renewed
          } catch (e) {
            if (!(e instanceof SignInExpired)) throw e
            // A writer that predates the lease may still have won the race.
            // Use its bundle rather than calling a live session signed out.
            const recovered = loadSession(fetchImpl, { force: true })
            if (
              recovered?.type === "oauth" && recovered.idToken && !spent(recovered) &&
              recovered.refresh !== base.refresh &&
              (!base.subject || !recovered.subject || recovered.subject === base.subject)
            ) return recovered
            throw e
          }
        })
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

// The tenant is cached per fetch implementation and per identity/override,
// with a TTL: membership changes should not need a process restart, and a
// test's fake Mistral must not inherit another test's workspace.
const TENANTS = new WeakMap()
const TENANT_TTL_MS = 10 * 60 * 1000
const TENANT_MAX = 64
async function oidcHeaders(fetchImpl, auth) {
  let cache = TENANTS.get(fetchImpl)
  if (!cache) TENANTS.set(fetchImpl, (cache = new Map()))
  const key = `${auth.subject ?? ""}|${process.env.VIBE_CLI_OIDC_ORGANIZATION_ID || ""}|${process.env.VIBE_CLI_OIDC_WORKSPACE_ID || ""}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < TENANT_TTL_MS)
    return { authorization: `Bearer ${auth.idToken}`, ...tenantHeaders(cached.tenant) }
  const tenant = await discoverTenant(fetchImpl, auth.idToken)
  cache.set(key, { tenant, at: Date.now() })
  if (cache.size >= TENANT_MAX) cache.delete(cache.keys().next().value)
  return { authorization: `Bearer ${auth.idToken}`, ...tenantHeaders(tenant) }
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
  // Do not spend a short-lived authorization code if the issuer's keys
  // cannot be read.
  if (eps.jwks) await jwksOf(fetchImpl, eps)
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
    redirect: "error",
  })
  let body
  try {
    body = await res.json()
  } catch {}
  if (!res.ok || body?.error) throw new OidcError(`Mistral OIDC exchange failed (HTTP ${res.status})${body?.error ? `: ${body.error}` : ""}`)
  const t = tokensOf(body)
  const claims = jwt(t.idToken)
  checkIdClaims(claims)
  await verifyIdToken(fetchImpl, eps, t.idToken)
  if (params.nonce && claims.nonce !== params.nonce) throw new OidcError("Mistral OIDC nonce mismatch")
  const email = typeof claims.email === "string" ? claims.email : undefined
  return { ...t, ...(email ? { email } : {}) }
}

// redirectUriOf is the loopback the browser is sent to: the CLI's own fixed
// port, or the override for when something else already holds it. The
// authorization request, the listener and the token request all read it
// from here, so they can never disagree.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])
const redirectUriOf = () => {
  const raw = process.env.VIBE_CLI_OIDC_REDIRECT_URI || REDIRECT_URI
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new OidcError("VIBE_CLI_OIDC_REDIRECT_URI is not a valid URL")
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port || Number(url.port) < 1)
    throw new OidcError("VIBE_CLI_OIDC_REDIRECT_URI must be an http loopback URL with an explicit port")
  return url.toString()
}

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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body><h1>Mistral Vibe sign-in</h1><p>${body}</p></body>`)
  }
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(redirectUri)
    } catch {
      reject(new OidcError("the sign-in redirect URI is not a valid URL"))
      return
    }
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port || Number(url.port) < 1) {
      reject(new OidcError("the sign-in redirect URI must be an http loopback URL with an explicit port"))
      return
    }
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
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
      let requested
      try {
        requested = new URL(req.url ?? "/", url.origin)
      } catch {
        res.writeHead(400, { "cache-control": "no-store" })
        res.end("bad request")
        return
      }
      // Ignore favicon/probe requests instead of treating them as sign-in
      // answers. The redirect URI's path is the only endpoint this listener
      // serves.
      if (req.method !== "GET" || requested.pathname !== url.pathname) {
        res.writeHead(404, { "cache-control": "no-store" })
        res.end()
        return
      }
      const q = Object.fromEntries(requested.searchParams)
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
    server.listen(Number(url.port), host)
    timer = setTimeout(() => fail(new OidcError("the browser sign-in expired (5 minutes)")), 5 * 60 * 1000)
    timer.unref?.()
  })
}

// A retry after a 401 has to send the body again. Strings and the other
// standard BodyInit values are replayable; streams are read once into a
// buffer, and a Request is cloned per attempt below.
const isReplayableBody = (body) =>
  body == null ||
  typeof body === "string" ||
  body instanceof URLSearchParams ||
  (typeof Blob !== "undefined" && body instanceof Blob) ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body) ||
  (typeof FormData !== "undefined" && body instanceof FormData)

const TOO_LARGE = Symbol("body-too-large")
const abortError = (signal) => {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new DOMException("aborted", "AbortError")
}
const abortable = (promise, signal) => {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort))
}

const bufferBody = async (body, signal, { request = false } = {}) => {
  if (isReplayableBody(body)) return body
  const tooLarge = () => {
    if (request) return TOO_LARGE
    throw new Error("request body is too large to reshape")
  }
  if (typeof body?.getReader === "function") {
    const reader = body.getReader()
    const chunks = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal)
        if (done) break
        const chunk = typeof value === "string"
          ? Buffer.from(value)
          : value instanceof Uint8Array ? value : new Uint8Array(value)
        size += chunk.byteLength
        if (size > MAX_SHAPED_BYTES) {
          try { reader.cancel().catch(() => {}) } catch {}
          return tooLarge()
        }
        chunks.push(chunk)
      }
      return new Uint8Array(Buffer.concat(chunks))
    } catch (e) {
      try { reader.cancel().catch(() => {}) } catch {}
      throw e
    } finally {
      try { reader.releaseLock() } catch {}
    }
  }
  if (typeof body?.[Symbol.asyncIterator] === "function") {
    const iterator = body[Symbol.asyncIterator]()
    const chunks = []
    let size = 0
    try {
      for (;;) {
        const step = await abortable(iterator.next(), signal)
        if (step.done) break
        const chunk = Buffer.from(step.value)
        size += chunk.byteLength
        if (size > MAX_SHAPED_BYTES) {
          try { await iterator.return?.() } catch {}
          return tooLarge()
        }
        chunks.push(chunk)
      }
      return new Uint8Array(Buffer.concat(chunks))
    } catch (e) {
      try { await iterator.return?.() } catch {}
      throw e
    }
  }
  return body
}

// The loader's fetch wrapper is shared by the plan and pasted-key paths: both
// talk to the same closed chat-completions schema, and both need a bounded
// turn, a non-followed redirect, and a replayable body after a 401. Only the
// credential headers and the OAuth refresh/retry step differ.
function providerFetch({ fetchImpl, oauth = false, auth, key }) {
  return async function fetch(input, init) {
    const req = input instanceof Request ? input : null
    // the request goes out as it was handed to us: a Request's method, body
    // and signal belong to the turn, and dropping them turns a chat POST into
    // a bodiless GET. The caller's own signal wins when it has one; otherwise
    // the turn gets a ceiling of our own, and no redirect is followed with the
    // plan's credentials in hand.
    const callerSignal = init?.signal ?? req?.signal
    const policy = {
      signal: callerSignal ?? AbortSignal.timeout(TURN_MS),
      redirect: init?.redirect ?? "error",
    }
    const hasInitBody = !!init && Object.prototype.hasOwnProperty.call(init, "body")
    let sendsBody = hasInitBody
    let retryBody
    const send = async (a) => {
      const headers = new Headers(req?.headers)
      if (init?.headers)
        for (const [k, v] of new Headers(init.headers)) headers.set(k, v)
      if (oauth) {
        for (const [k, v] of Object.entries(await oidcHeaders(fetchImpl, a))) headers.set(k, v)
      } else {
        headers.set("authorization", `Bearer ${key}`)
      }
      const attemptInit = { ...init, headers, ...policy }
      if (sendsBody) {
        // shaping can change the body's length; let fetch recompute it
        headers.delete("content-length")
        attemptInit.body = retryBody
      }
      return fetchImpl(
        req ? new Request(req.clone(), attemptInit) : input,
        req ? undefined : attemptInit,
        "chat",
      )
    }
    let res
    try {
      const typed = new Headers()
      if (req?.headers)
        for (const [k, v] of req.headers) typed.set(k, v)
      if (init?.headers)
        for (const [k, v] of new Headers(init.headers)) typed.set(k, v)
      const url = req?.url ?? (input instanceof URL ? input.href : typeof input === "string" ? input : input?.url)
      const method = (req?.method ?? init?.method ?? "GET").toUpperCase()
      const contentType = typed.get("content-type") ?? ""
      const shape = (body) => shapedBody(body, url, contentType, method)
      const chatRequest = method === "POST" && chatURL(url)
      // Read the body once, before the first attempt: the retry below sends
      // the same turn again, and a stream can only be read once. Shaping is
      // limited to chat POST bodies; other requests keep their bytes.
      if (hasInitBody) {
        const replayable = isReplayableBody(init.body)
        if (chatRequest || (oauth && !replayable))
          retryBody = chatRequest ? shape(await bufferBody(init.body, policy.signal)) : await bufferBody(init.body, policy.signal)
        else
          retryBody = init.body
        sendsBody = true
      } else if (chatRequest && req?.body && !(Number(typed.get("content-length")) > MAX_SHAPED_BYTES)) {
        const read = await bufferBody(req.clone().body, policy.signal, { request: true })
        if (read !== TOO_LARGE) {
          const reshaped = shape(read)
          if (reshaped != null) {
            retryBody = reshaped
            sendsBody = true
          }
        }
      }
      if (oauth) {
        const { a, renewed } = await freshOidc(fetchImpl, auth)
        res = await send(a)
        if (res.status === 401 && !renewed) {
          // turned away before its end: the platform refused a token the
          // local clock called fresh, so renew once from the bundle this call
          // holds — never from the stored one, whose refresh token a renewal
          // has already consumed — and then no more, so one turn spends at
          // most one refresh token
          const n = await freshOidc(fetchImpl, a, { force: true })
          res = await send(n.a)
        }
      } else {
        res = await send(null)
      }
    } catch (e) {
      // Cancellation belongs to the caller, not to the OpenAI error envelope.
      // A timeout generated above still becomes a reported 502 because it is
      // not the caller's signal.
      if (callerSignal?.aborted && e?.name === "AbortError") throw e
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: e?.message ?? String(e) } }), {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "application/json" },
      })
    }
    return res
  }
}

function createPlugin({ fetchImpl = globalThis.fetch } = {}) {
  return {
    config: async (cfg) => {
      // a cfg the host already filled in — a second run of the hook, or a
      // user's own block — is completed, not replaced: the bootstrap rows are
      // added, while the host's rows keep their names and settings. A cfg that
      // cannot be written at all is left alone rather than thrown out of the
      // hook.
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
            // The host may not call callback() until it has shown the URL. A
            // port error or the five-minute timeout must not become an
            // unhandled rejection before then.
            waiting.catch(() => {})
            return {
              url,
              instructions: "Sign in to Mistral in the browser and approve; this finishes by itself.",
              method: "auto",
              async callback() {
                try {
                  const done = await waiting
                  try {
                    const t = await exchangeCode(fetchImpl, { code: done.code, verifier, nonce, redirectUri })
                    // the sign-in is the session from the start: whatever an
                    // earlier run left in the file is superseded by it. Take
                    // the renewal lease so an in-flight renewal cannot write
                    // the old chain back after this sign-in.
                    try {
                      await withSessionLock(async () => saveSession(fetchImpl, { ...t, type: "oauth" }))
                    } catch {
                      saveSession(fetchImpl, { ...t, type: "oauth" })
                    }
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
        } catch (e) {
          // A refused refresh is actionable sign-in state; a transient
          // token-endpoint/JWKS failure stays a quiet retry, as before.
          if (e instanceof SignInExpired) throw e
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
            fetch: providerFetch({ fetchImpl, oauth: true, auth }),
          }
        }
        const key = liveKey(auth)
        if (!key) return {}
        return {
          baseURL: BASE,
          apiKey: key,
          fetch: providerFetch({ fetchImpl, oauth: false, key }),
        }
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
              const { ids } = await modelTable(fetchImpl, headers, { plan: true })
              if (!ids.length) error = "Mistral answered no model list for this account"
            } catch (e) {
              if (!(e instanceof Refused)) throw e
              if (e.status === 401) {
                error = "Mistral refused this sign-in; sign in again"
                signIn = "expired"
              } else {
                error = `Mistral could not read this account's models (HTTP ${e.status}); check workspace access`
              }
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
          if (e instanceof Refused) {
            if (e.status === 401)
              return { error: auth?.type === "oauth" ? "Mistral refused this sign-in; sign in again" : "Mistral refused this key; paste a fresh one", signIn: "expired", windows: [] }
            return { error: auth?.type === "oauth" ? `Mistral refused this account (HTTP ${e.status}); check workspace access` : `Mistral refused this key (HTTP ${e.status}); check its permissions`, windows: [] }
          }
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
          table = await modelTable(fetchImpl, headers, { plan: cur?.type === "oauth" })
        } catch (e) {
          if (!(e instanceof Refused)) return provider.models
          throw Object.assign(
            new Error(cur?.type === "oauth"
              ? e.status === 401 ? "Mistral refused this sign-in; sign in again" : `Mistral could not read this account's models (HTTP ${e.status}); check workspace access`
              : e.status === 401 ? "Mistral refused this key (HTTP 401); paste a fresh one" : `Mistral refused this key (HTTP ${e.status}); check its permissions`),
            e.status === 401 ? { signIn: "expired" } : {},
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
  callbackServer, redirectUriOf, currentOidc, remember, MAX_RENEWALS, DEFAULT_ACCESS_MS, TURN_MS,
  sessionPath, loadSession, saveSession, newerSession,
  chatBody, chatMessage, shapedBody, chatURL, bufferBody, isReplayableBody,
}
