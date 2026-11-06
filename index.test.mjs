import { test as nodeTest } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signCrypto } from "node:crypto"
import { createServer } from "node:http"
import { mkdirSync, readFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VibePlugin, _internal } from "./index.mjs"

const createPlugin = _internal.createPlugin

// Every test in this file runs inside its own environment snapshot. A
// developer's own MISTRAL_API_KEY — or their ~/.vibe/.env — must not turn a
// test green or red, and no test may leave a variable behind for the next
// one: each starts from the same empty VIBE_HOME, a session file of its own,
// and gets its snapshot back.
// The wrapper shadows the runner's own test on purpose, so a test cannot
// forget to be isolated.
const EMPTY_VIBE_HOME = mkdtempSync(join(tmpdir(), "vibe-test-"))
const KEYS = /^(MISTRAL_|VIBE_)/
let SESSIONS = 0
const test = (name, fn) =>
  nodeTest(name, async () => {
    const saved = { ...process.env }
    for (const k of Object.keys(process.env)) if (KEYS.test(k)) delete process.env[k]
    process.env.VIBE_HOME = EMPTY_VIBE_HOME
    // and the session file of its own: a renewal one test wrote must not
    // answer the next test's requests
    const session = join(EMPTY_VIBE_HOME, `session-${SESSIONS++}.json`)
    process.env.VIBE_SESSION_FILE = session
    try {
      return await fn()
    } finally {
      rmSync(session, { force: true })
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      for (const k of Object.keys(saved)) process.env[k] = saved[k]
    }
  })
process.on("exit", () => rmSync(EMPTY_VIBE_HOME, { recursive: true, force: true }))

test("the package root is the plugin entry point and nothing else", async () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  assert.equal(pkg.main, "./opencode.mjs")
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./package.json"])
  assert.equal(pkg.exports["."], "./opencode.mjs")
  assert.ok(pkg.files.includes("scripts"), "the live check the README documents ships with the package")
  assert.equal(pkg.scripts.test, "node --test index.test.mjs")
  // the internal factory is not reachable from the package name, only the plugin is
  const entry = await import("./opencode.mjs")
  assert.deepEqual(Object.keys(entry), ["VibePlugin"])
})

test("the plugin entry point is a plugin the host can call", async () => {
  const p = await VibePlugin()
  assert.equal(p.auth.provider, _internal.ID)
  assert.equal(p.provider.id, _internal.ID)
  const cfg = {}
  await p.config(cfg)
  assert.ok(cfg.provider[_internal.ID].models)
})

test("config hook starts the bootstrap provider", async () => {
  const p = await createPlugin()
  const cfg = {}
  await p.config(cfg)
  const provider = cfg.provider[_internal.ID]
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  assert.equal(provider.api, _internal.BASE)
  assert.ok(Object.keys(provider.models).length >= 5)
})

test("config hook completes a provider block the host already has", async () => {
  const p = await createPlugin()
  const cfg = { provider: { vibe: { models: { "mistral-large-4-0": { name: "mine" } } } } }
  await p.config(cfg)
  const block = cfg.provider[_internal.ID]
  assert.equal(block.name, "Mistral Vibe")
  assert.equal(block.npm, "@ai-sdk/openai-compatible")
  assert.equal(block.api, _internal.BASE)
  // the host's own row is kept and the bootstrap's other rows are added
  assert.equal(block.models["mistral-large-4-0"].name, "mine")
  assert.ok(Object.keys(block.models).length > 1)
})

test("config hook leaves a cfg it cannot write alone", async () => {
  const p = await createPlugin()
  await p.config(Object.freeze({}))
  await p.config(Object.freeze({ provider: Object.freeze({}) }))
})

test("row keeps the capabilities both readers read", () => {
  const r = _internal.row({ "x-1": { context: 262000, output: 16000, image: false, efforts: ["none", "medium"] } }, "x-1")
  assert.equal(r.modalities.input[0], "text")
  assert.equal(r.capabilities.reasoning, true)
  assert.deepEqual(Object.keys(r.variants), ["none", "medium"])
})

test("a catalog entry that says vision:false beats the bootstrap's image flag", () => {
  const no = _internal.row({ "m-1": { context: 1000, image: true, efforts: [] } }, "m-1", { capabilities: { vision: false } })
  assert.deepEqual(no.modalities.input, ["text"])
  assert.equal(no.capabilities.attachment, false)
  assert.equal(no.capabilities.input.image, false)
  // and the other way round: the catalog is what speaks, either way
  const yes = _internal.row({ "m-2": { context: 1000, image: false, efforts: [] } }, "m-2", { capabilities: { vision: true } })
  assert.deepEqual(yes.modalities.input, ["text", "image"])
  // a catalog that says nothing about vision leaves the bootstrap's guess alone
  const quiet = _internal.row({ "m-3": { context: 1000, image: true, efforts: [] } }, "m-3", { capabilities: { function_calling: true } })
  assert.deepEqual(quiet.modalities.input, ["text", "image"])
})

test("rowsFor lists what /v1/models says, keeping the bootstrap row", () => {
  const rows = _internal.rowsFor(["codestral-latest", "unknown-model"])
  assert.equal(rows["codestral-latest"].name, "Codestral")
  assert.equal(rows["unknown-model"].name, "unknown-model")
  assert.ok(rows["codestral-latest"].limit.context > 0)
  assert.ok(!("limit" in rows["unknown-model"]) || rows["unknown-model"].limit.context > 0)
})

test("usage marks the account expired when the key is refused, without a credential it points to sign in", async () => {
  const p = await createPlugin({ fetchImpl: async (url) => ({ status: 401, ok: false, url, json: async () => ({}) }) })
  const refused = await p.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.equal(refused.signIn, "expired")
  const none = await p.auth.usage(async () => null)
  assert.match(none.error, /not signed in/)
})

test("usage does not mark the account for sign-in when the tables are unreachable", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/model-catalog", () => { throw new Error("dns") }],
    ["/models", () => { throw new Error("dns") }],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u16", exp: Math.floor(Date.now() / 1000) + 3600, email: "me@x.y" }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u16", email: "me@x.y",
  }))
  assert.equal(out.user, "me@x.y")
  assert.match(out.error, /no model list/)
  // an unreachable table says nothing about the sign-in: only a refusal marks it
  assert.equal(out.signIn, undefined)
})

test("loader serves the pasted key first, then the env-resolved one", async () => {
  const p = await createPlugin({ fetchImpl: globalThis.fetch })
  const loader = p.auth.loader
  const pasted = await loader(async () => ({ type: "api", key: "pasted" }))
  assert.equal(pasted.baseURL, _internal.BASE)
  assert.equal(pasted.apiKey, "pasted")
  const none = await loader(async () => null)
  assert.deepEqual(none, {})
})

test("an OIDC bundle with no ID token is a broken sign-in, not the env key", async () => {
  process.env.MISTRAL_API_KEY = "env-key"
  const p = await createPlugin({ fetchImpl: async () => { throw new Error("no request may be sent") } })
  await assert.rejects(() => p.auth.loader(async () => ({ type: "oauth", subject: "u14", expires: Date.now() + 3600_000 })), (e) => e.signIn === "expired")
  await assert.rejects(() => p.provider.models({ models: {} }, { auth: { type: "oauth", subject: "u14" } }), (e) => e.signIn === "expired")
})

test("resolveApiKey reads MISTRAL_API_KEY and VIBE_API_KEY_ENV_VAR", () => {
  assert.equal(_internal.resolveApiKey(), null)
  process.env.MISTRAL_API_KEY = "abc"
  assert.equal(_internal.resolveApiKey(), "abc")
  process.env.VIBE_API_KEY_ENV_VAR = "OTHER_KEY"
  delete process.env.MISTRAL_API_KEY
  assert.equal(_internal.resolveApiKey(), null)
  process.env.OTHER_KEY = "def"
  assert.equal(_internal.resolveApiKey(), "def")
})

test("resolveApiKey falls back to $VIBE_HOME/.env, and only to that one", () => {
  const home = mkdtempSync(join(tmpdir(), "vibe-home-"))
  process.env.VIBE_HOME = home
  writeFileSync(join(home, ".env"), '# a comment\nMISTRAL_API_KEY="from-file"\nOTHER=1\n')
  assert.equal(_internal.resolveApiKey(), "from-file")
  rmSync(home, { recursive: true, force: true })
})

test("provider.models keeps the previous list on refusal and network failure", async () => {
  let status = 401
  const tables = (url) => url.includes("model-catalog") ? { models: [] } : { data: [{ id: "one" }] }
  const p = await createPlugin({ fetchImpl: async (url) => (status === 500 ? Promise.reject(new Error("down")) : { status, ok: status < 400, url, json: async () => tables(String(url)) }) })
  await assert.rejects(() => p.provider.models({}, { auth: { type: "api", key: "k" } }), /refused/)
  status = 500
  const kept = await p.provider.models({ models: { kept: true } }, { auth: { type: "api", key: "k" } })
  assert.deepEqual(kept, { kept: true })
  status = 200
  const live = await p.provider.models({ models: { kept: true } }, { auth: { type: "api", key: "k" } })
  assert.deepEqual(live, _internal.rowsFor(["one"]))
})

// ---- OIDC: helpers for the fake pieces -------------------------------------------

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const ID_CLAIMS = { iss: _internal.ISSUER, aud: _internal.CLIENT_ID, sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3300, nonce: undefined }
const mkId = (claims = {}) => ["h", b64({ ...ID_CLAIMS, ...claims }), "y"].join(".")
const BUNDLE = (n = 3300, id = mkId()) => ({ access_token: "at", refresh_token: "rt", id_token: id, expires_in: n })
const signedId = (claims, privateKey, header = { alg: "RS256", kid: "key-1" }) => {
  const head = b64(header)
  const payload = b64({ ...ID_CLAIMS, ...claims })
  const data = `${head}.${payload}`
  return `${data}.${signCrypto("sha256", Buffer.from(data), privateKey).toString("base64url")}`
}

// fetch of fake Mistral endpoints, routed by URL. res carries status/json/text.
function fakeFetch(routes) {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url: String(url), ...(init ? { init } : {}) })
    for (const [match, build] of routes) if (String(url).includes(match)) return build(String(url), init, seen)
    return { status: 404, ok: false, json: async () => ({}), url: String(url), headers: init?.headers }
  }
  fetch.seen = seen
  return fetch
}

const json = (status, body, res = {}) => ({ status, ok: status < 400, json: async () => body, ...res })

test("authorizationUrl carries the CLI's registration, PKCE, loopback redirect and audience", async () => {
  const f = fakeFetch([[".well-known", () => json(200, { authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token" })]])
  const url = new URL(await _internal.authorizationUrl(f, { challenge: "c", state: "s", nonce: "n" }))
  assert.equal(url.searchParams.get("client_id"), _internal.CLIENT_ID)
  assert.equal(url.searchParams.get("audience"), _internal.AUDIENCE)
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("redirect_uri"), _internal.REDIRECT_URI)
  assert.ok(url.searchParams.get("scope").includes("offline_access"))
})

test("the browser URL and the token request name the same redirect under the override", async () => {
  process.env.VIBE_CLI_OIDC_REDIRECT_URI = "http://127.0.0.1:9999/callback"
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token" })],
    ["/token", () => json(200, BUNDLE(300, mkId({ nonce: "n", exp: Math.floor(Date.now() / 1000) + 600 })))],
  ])
  const url = new URL(await _internal.authorizationUrl(f, { challenge: "c", state: "s", nonce: "n" }))
  await _internal.exchangeCode(f, { code: "cd", verifier: "v", nonce: "n" })
  const wanted = "http://127.0.0.1:9999/callback"
  assert.equal(url.searchParams.get("redirect_uri"), wanted)
  assert.equal(new URLSearchParams(f.seen[1].init.body).get("redirect_uri"), wanted)
})

test("exchangeCode trades the code, checks iss/aud/nonce, keeps the email", async () => {
  const f = fakeFetch([["/token", () => json(200, BUNDLE(300, mkId({ nonce: "n", sub: "user-1", exp: Math.floor(Date.now() / 1000) + 600, email: "a@b.c" })))], [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })]])
  const t = await _internal.exchangeCode(f, { code: "cd", verifier: "v", nonce: "n" })
  assert.equal(t.refresh, "rt")
  assert.equal(t.email, "a@b.c")
  assert.equal(t.subject, "user-1")
  const up = new URLSearchParams(f.seen[1].init.body)
  assert.equal(up.get("grant_type"), "authorization_code")
  assert.equal(up.get("code"), "cd")
  await assert.rejects(() => _internal.exchangeCode(f, { code: "cd", verifier: "v", nonce: "other" }), /nonce/)
})

test("exchangeCode verifies the ID token against the discovery JWKS", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig", alg: "RS256" }
  const idToken = signedId({ sub: "jwk-user", nonce: "n", email: "jwk@x.y", exp: Math.floor(Date.now() / 1000) + 600 }, privateKey)
  const discovery = {
    issuer: _internal.ISSUER,
    authorization_endpoint: "https://auth.example/authorize",
    token_endpoint: "https://auth.example/token",
    jwks_uri: "https://auth.example/jwks",
  }
  const good = fakeFetch([
    [".well-known", () => json(200, discovery)],
    ["/jwks", () => json(200, { keys: [jwk] })],
    ["/token", () => json(200, { access_token: "at", refresh_token: "rt", id_token: idToken, expires_in: 600 })],
  ])
  const t = await _internal.exchangeCode(good, { code: "c", verifier: "v", nonce: "n" })
  assert.equal(t.subject, "jwk-user")
  assert.equal(t.email, "jwk@x.y")

  const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const forged = signedId({ sub: "jwk-user", nonce: "n", exp: Math.floor(Date.now() / 1000) + 600 }, other.privateKey)
  const bad = fakeFetch([
    [".well-known", () => json(200, discovery)],
    ["/jwks", () => json(200, { keys: [jwk] })],
    ["/token", () => json(200, { access_token: "at", refresh_token: "rt", id_token: forged, expires_in: 600 })],
  ])
  await assert.rejects(() => _internal.exchangeCode(bad, { code: "c", verifier: "v", nonce: "n" }), /signature/)
})

test("a discovery document with an issuer but no JWKS is rejected", async () => {
  const f = fakeFetch([[".well-known", () => json(200, {
    issuer: _internal.ISSUER,
    authorization_endpoint: "https://auth.example/authorize",
    token_endpoint: "https://auth.example/token",
  })]])
  await assert.rejects(() => _internal.endpoints(f), /JWKS/)
})

test("refreshToken rotates credentials and keeps the old refresh when none is sent", async () => {
  let call = 0
  const f = fakeFetch([
    ["/token", (url, init) => {
      call++
      return json(200, { access_token: `at${call}`, id_token: mkId({ sub: "u", exp: Math.floor(Date.now() / 1000) + 900 }), expires_in: 900 })
    }],
  ])
  const t = await _internal.refreshToken(f, { token: "https://auth.example/token" }, "old-rt")
  assert.equal(t.access, "at1")
  assert.equal(t.refresh, "old-rt")
  const up = new URLSearchParams(f.seen[0].init.body)
  assert.equal(up.get("grant_type"), "refresh_token")
  assert.equal(up.get("refresh_token"), "old-rt")
})

test("a token answer with no expires_in is read as the hour Mistral grants", () => {
  // the ID token of a bundle the platform just minted, stamped 8 hours
  // behind UTC: its exp is already in the past, and is not a usable clock
  const stale = mkId({ sub: "u", exp: Math.floor(Date.now() / 1000) - 28800 })
  const t = _internal.tokensOf({ access_token: "at", refresh_token: "rt", id_token: stale }, {})
  assert.ok(t.expires > Date.now() + 59 * 60 * 1000, "the bundle is not born already spent")
  assert.equal(_internal.spent({ type: "oauth", ...t }), false)
})

test("a rejected refresh marks the account expired", async () => {
  const f = fakeFetch([["/token", () => json(400, { error: "invalid_grant" })]])
  await assert.rejects(() => _internal.refreshToken(f, { token: "https://auth.example/token" }, "r"), (e) => e.signIn === "expired")
})

test("freshOidc stops renewing when every answer is already spent", async () => {
  let calls = 0
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/token", () => {
      calls++
      return json(200, { access_token: "at", refresh_token: "rt", id_token: mkId({ sub: "loop-1" }), expires_in: 30 })
    }],
  ])
  const auth = { type: "oauth", access: "at0", refresh: "rt", expires: Date.now() - 1000, idToken: mkId({ sub: "loop-1" }), subject: "loop-1" }
  await assert.rejects(() => _internal.freshOidc(f, auth), /already-expired/)
  // one renewal plus the retries, and then it is reported rather than looped
  assert.equal(calls, _internal.MAX_RENEWALS + 1)
})

test("oidcHeaders sends the ID token with the workspace headers, discovered once", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", (url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${mkId()}`)
      return json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })
    }],
  ])
  const idToken = mkId()
  const idExpires = Math.floor(Date.now() / 1000) + 3600
  const auth = { type: "oauth", access: "at", refresh: "rt", expires: Date.now() + 3600_000, idToken, idExpires, subject: "u1" }
  const first = await _internal.oidcHeaders(f, auth)
  assert.deepEqual(first, {
    authorization: `Bearer ${idToken}`,
    "x-external-organization-id": "o1",
    "x-external-workspace-id": "w1",
  })
  const second = await _internal.oidcHeaders(f, auth)
  assert.deepEqual(second, first)
  assert.equal(f.seen.filter((s) => s.url.includes("/workspaces")).length, 1)
})

test("loader's fetch carries the OIDC headers and renews a spent sign-in before a chat", async () => {
  const newId = mkId({ sub: "u2", exp: Math.floor(Date.now() / 1000) + 3600 })
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/chat/completions", (url, init) => {
      // first call arrives with the spent token, the retry with the new one
      return json(200, { ok: true, authorization: init.headers instanceof Headers ? init.headers.get("authorization") : init.headers.authorization })
    }],
    ["/token", () => json(200, { access_token: "at2", refresh_token: "rt2", id_token: newId, expires_in: 3600 })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() - 1000,
    idToken: mkId({ sub: "u2", exp: Math.floor(Date.now() / 1000) - 10 }),
    idExpires: (Math.floor(Date.now() / 1000) - 10) * 1000,
    subject: "u2",
  }))
  assert.equal(loader.baseURL, _internal.BASE)
  const res = await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
  assert.equal((await res.json()).authorization, `Bearer ${newId}`)
})

test("a 401 on a token the clock called fresh renews once and retries", async () => {
  const minted = []
  let chats = 0
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/token", () => {
      const id = mkId({ sub: "u6", exp: Math.floor(Date.now() / 1000) + 3600 })
      minted.push(id)
      return json(200, { access_token: "at", refresh_token: `rt${minted.length}`, id_token: id, expires_in: 3600 })
    }],
    ["/chat/completions", (url, init) => {
      chats++
      return json(chats === 1 ? 401 : 200, { token: init.headers.get("authorization") })
    }],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at0", refresh: "rt0", expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u6" }), subject: "u6",
  }))
  const res = await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).token, `Bearer ${minted[0]}`)
  // one renewal, and the turn retried on the bundle it produced
  assert.equal(minted.length, 1)
  assert.equal(chats, 2)
})

test("a 401 after a renewal does not spend a second refresh token", async () => {
  const minted = []
  let chats = 0
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/token", () => {
      const id = mkId({ sub: "u7", exp: Math.floor(Date.now() / 1000) + 3600 })
      minted.push(id)
      return json(200, { access_token: "at", refresh_token: `rt${minted.length}`, id_token: id, expires_in: 3600 })
    }],
    ["/chat/completions", () => { chats++; return json(401, {}) }],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at0", refresh: "rt0", expires: Date.now() - 1000,
    idToken: mkId({ sub: "u7" }), subject: "u7",
  }))
  // the pre-flight already renewed, so a refusal is the platform's own
  // answer — not a second refresh off a token the first one consumed, and
  // not a 502 that calls a working session signed out
  const res = await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
  assert.equal(res.status, 401)
  assert.equal(minted.length, 1)
  assert.equal(chats, 1)
})

test("loader's fetch sends a Request's own method and body, with the plan's headers", async () => {
  const seen = []
  const f = async (input, init) => {
    const req = input instanceof Request ? input : null
    const url = req ? req.url : String(input)
    seen.push({ url, req, init })
    if (url.includes("/chat/completions")) return json(200, { ok: true })
    if (url.includes("/users/me/workspaces")) return json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })
    return json(404, {})
  }
  const p = await createPlugin({ fetchImpl: f })
  const idToken = mkId({ sub: "u12" })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at", refresh: "rt", expires: Date.now() + 3600_000, idToken, subject: "u12",
  }))
  const res = await loader.fetch(new Request(`${_internal.BASE}/chat/completions`, {
    method: "POST", body: '{"model":"mistral-large-4-0"}', headers: { "content-type": "application/json" },
  }))
  assert.equal(res.status, 200)
  const chat = seen.find((s) => s.url.includes("/chat/completions"))
  assert.ok(chat.req, "the Request itself went out, rebuilt with the plan's headers")
  assert.equal(chat.req.method, "POST")
  assert.equal(await chat.req.text(), '{"model":"mistral-large-4-0"}')
  assert.equal(chat.req.headers.get("content-type"), "application/json")
  assert.equal(chat.req.headers.get("authorization"), `Bearer ${idToken}`)
  assert.equal(chat.req.headers.get("x-external-organization-id"), "o1")
})

// ---- the request body Mistral's closed schema takes ---------------------------

// A fetch that records the body each chat turn went out with, in either of
// the two shapes a host hands one over: a Request, or a URL with an init.
function bodyRecorder() {
  const seen = []
  const fetch = async (input, init) => {
    const req = input instanceof Request ? input : null
    const url = req ? req.url : String(input)
    let body
    if (init && "body" in init) body = init.body
    else if (req) body = await req.text()
    seen.push({
      url,
      req,
      body: typeof body === "string" ? body : body == null ? null : new TextDecoder().decode(body),
      headers: new Headers(req?.headers ?? init?.headers),
    })
    if (url.includes("/users/me/workspaces")) return json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })
    return json(200, { ok: true })
  }
  fetch.seen = seen
  fetch.chats = () => seen.filter((s) => s.url.includes("/chat/completions"))
  return fetch
}

// the loader of a signed-in account over f, as the hosts call it
const loaderOver = async (f) => {
  const p = await createPlugin({ fetchImpl: f })
  return p.auth.loader(async () => ({
    type: "oauth", access: "at", refresh: "rt", expires: Date.now() + 3600_000, idToken: mkId({ sub: "u40" }), subject: "u40",
  }))
}

const CHAT = `${_internal.BASE}/chat/completions`

test("a chat body carrying a field Mistral does not name goes out without it", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  // the body LobeChat sent magpie's gateway, which forwarded it as written
  // and was refused with 422 extra_forbidden @ body.user
  const res = await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mistral-medium-latest",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      user: "user_q9y2muJSdB5nFtc05GK2kom6nzr",
      functions: [],
      function_call: { name: "legacy" },
    }),
  })
  assert.equal(res.status, 200)
  assert.equal(f.chats().length, 1)
  assert.equal(f.chats()[0].body, JSON.stringify({
    model: "mistral-medium-latest",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  }))
})

test("seed goes out as random_seed, and the reply limit as the one field Mistral names", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", seed: 7, max_completion_tokens: 512, messages: [] }),
  })
  assert.deepEqual(JSON.parse(f.chats()[0].body), { model: "m", random_seed: 7, max_tokens: 512, messages: [] })
})

test("the reply limit is kept whichever spelling the client used, and the pair is never sent", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", max_tokens: 8, max_completion_tokens: 100, messages: [] }),
  })
  assert.deepEqual(JSON.parse(f.chats()[0].body), { model: "m", max_tokens: 8, messages: [] })
})

test("a service_tier Mistral does not answer is dropped, one it answers is kept", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", service_tier: "priority", messages: [] }),
  })
  assert.deepEqual(JSON.parse(f.chats()[0].body), { model: "m", messages: [] })
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", service_tier: "auto", messages: [] }),
  })
  assert.deepEqual(JSON.parse(f.chats()[1].body), { model: "m", service_tier: "auto", messages: [] })
})

test("a temperature past Mistral's ceiling goes out at the ceiling", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", temperature: 2.5, messages: [] }),
  })
  assert.equal(JSON.parse(f.chats()[0].body).temperature, 1.5)
})

test("a developer message goes out as a system one, and a turn's thinking where Mistral takes it", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "m",
      messages: [
        { role: "developer", content: "be brief" },
        { role: "user", content: "hi", name: "alice" },
        { role: "assistant", content: "hello", reasoning_content: "I thought", refusal: "no" },
        { role: "user", content: "say ok" },
      ],
    }),
  })
  assert.deepEqual(JSON.parse(f.chats()[0].body).messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: [{ type: "text", text: "I thought" }] },
        { type: "text", text: "hello" },
      ],
    },
    { role: "user", content: "say ok" },
  ])
})

test("a tool turn's exchange goes out with only the fields its roles name", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: "read" },
        {
          role: "assistant",
          content: null,
          reasoning_details: [{ text: "t" }],
          tool_calls: [{ id: "c1", index: 0, type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "data", is_error: false, name: "read" },
        { role: "user", content: "say ok" },
      ],
    }),
  })
  assert.deepEqual(JSON.parse(f.chats()[0].body).messages, [
    { role: "user", content: "read" },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: [{ type: "text", text: "t" }] }],
      tool_calls: [{ id: "c1", index: 0, type: "function", function: { name: "read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "data", name: "read" },
    { role: "user", content: "say ok" },
  ])
})

test("a body Mistral takes as it comes leaves in the bytes it arrived in", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  // stream_options and metadata are not in Mistral's published schema but
  // are answered 200, so they are none of this plugin's business
  const sent = JSON.stringify({
    model: "mistral-medium-latest",
    max_tokens: 8,
    stream: true,
    stream_options: { include_usage: true },
    metadata: { k: "v" },
    messages: [{ role: "user", content: "say ok" }],
  })
  await loader.fetch(CHAT, { method: "POST", headers: { "content-type": "application/json" }, body: sent })
  assert.equal(f.chats()[0].body, sent)
  // and a number survives the round trip untouched, because there is none
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"model":"m","user":"u","temperature":0.30000000000000004,"messages":[]}',
  })
  assert.equal(f.chats()[1].body, '{"model":"m","temperature":0.30000000000000004,"messages":[]}')
})

test("only a chat completions POST is reshaped", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  await loader.fetch(`${_internal.BASE}/models`, { method: "GET" })
  const models = f.seen.filter((s) => s.url.includes("/models"))
  assert.equal(models.length, 1)
  assert.equal(models[0].body, null)
  await loader.fetch(CHAT, { method: "POST", body: "not json at all" })
  assert.equal(f.chats()[0].body, "not json at all")
  await loader.fetch(CHAT, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"user":"u"}' })
  assert.equal(f.chats()[1].body, '{"user":"u"}')
})

test("a Request's body is reshaped too, and the retry sends the same one", async () => {
  let tokenCalls = 0
  let chats = 0
  const f = bodyRecorder()
  const wrapped = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes(".well-known"))
      return json(200, { authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token" })
    if (url.includes("/token")) {
      tokenCalls++
      return json(200, { access_token: "at1", refresh_token: "rt1", id_token: mkId({ sub: "u41" }), expires_in: 3600 })
    }
    if (url.includes("/chat/completions")) {
      // the body is recorded before the answer is decided, so both the
      // attempt that was turned away and the retry are on record
      const out = await f(input, init)
      return json(++chats === 1 ? 401 : 200, await out.json())
    }
    return f(input, init)
  }
  wrapped.seen = f.seen
  wrapped.chats = f.chats
  const p = await createPlugin({ fetchImpl: wrapped })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at", refresh: "rt", expires: Date.now() + 3600_000, idToken: mkId({ sub: "u41" }), subject: "u41",
  }))
  const res = await loader.fetch(new Request(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", user: "user_x", messages: [{ role: "user", content: "hi" }] }),
  }))
  assert.equal(res.status, 200)
  assert.equal(chats, 2, "the 401 was retried")
  assert.equal(tokenCalls, 1)
  assert.equal(f.chats().length, 2)
  for (const c of f.chats()) {
    assert.equal(c.body, JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }))
    assert.equal(c.headers.get("authorization"), `Bearer ${mkId({ sub: "u41" })}`)
  }
})

test("an API key loader shapes the same chat body as the plan path", async () => {
  const f = bodyRecorder()
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({ type: "api", key: "k" }))
  assert.equal(typeof loader.fetch, "function")
  const res = await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", user: "u", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(res.status, 200)
  assert.equal(f.chats()[0].body, JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }))
  assert.equal(f.chats()[0].headers.get("authorization"), "Bearer k")
})

test("shaping drops a stale content-length header", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  const body = JSON.stringify({ model: "m", user: "u", messages: [] })
  await loader.fetch(CHAT, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    body,
  })
  assert.notEqual(f.chats()[0].body, body)
  assert.equal(f.chats()[0].headers.get("content-length"), null)
})

test("a no-op chat body is not reserialized", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  const body = '{ "model" : "m", "messages" : [ { "role" : "user", "content" : "hi" } ] }'
  await loader.fetch(CHAT, { method: "POST", headers: { "content-type": "application/json" }, body })
  assert.equal(f.chats()[0].body, body)
})

test("an Object-prototype role is left for Mistral instead of throwing", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  const body = JSON.stringify({ model: "m", messages: [{ role: "constructor", content: "x" }] })
  const res = await loader.fetch(CHAT, { method: "POST", headers: { "content-type": "application/json" }, body })
  assert.equal(res.status, 200)
  assert.equal(f.chats()[0].body, body)
})

test("a non-POST chat URL is not reshaped", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  const body = '{"user":"u"}'
  await loader.fetch(CHAT, { method: "GET", headers: { "content-type": "application/json" }, body })
  assert.equal(f.chats()[0].body, body)
})

test("a URL input is reshaped too", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  await loader.fetch(new URL(CHAT), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", user: "u", messages: [] }),
  })
  assert.equal(f.chats()[0].body, JSON.stringify({ model: "m", messages: [] }))
})

test("a caller abort stops a streamed body before anything is sent", async () => {
  const f = bodyRecorder()
  const loader = await loaderOver(f)
  const stream = new ReadableStream({ start() {} })
  await assert.rejects(
    () => loader.fetch(CHAT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      signal: AbortSignal.abort(),
    }),
    (e) => e.name === "AbortError",
  )
  assert.equal(f.chats().length, 0)
})

test("the chat request carries a deadline of its own, and the caller's signal wins", async () => {
  const seen = []
  const f = async (input, init) => {
    seen.push(init)
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes("/users/me/workspaces")) return json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })
    return json(200, { ok: true })
  }
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at", refresh: "rt", expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u17" }), subject: "u17",
  }))
  await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
  const first = seen.at(-1)
  assert.ok(first.signal instanceof AbortSignal, "a turn the platform never answers does not hang forever")
  assert.equal(first.redirect, "error")
  const mine = AbortSignal.timeout(60_000)
  await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST", signal: mine })
  assert.equal(seen.at(-1).signal, mine)
})

test("a failed renewal inside loader's fetch answers 502, it does not throw", async () => {
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/token", () => json(400, { error: "invalid_grant" })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at0", refresh: "rt0", expires: Date.now() - 1000,
    idToken: mkId({ sub: "u13" }), subject: "u13",
  }))
  const res = await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
  assert.equal(res.status, 502)
  assert.match((await res.json()).error.message, /signed out/)
})

test("a renewed bundle is reused by the next request instead of the consumed refresh token", async () => {
  const spentTokens = []
  const minted = []
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/token", (url, init) => {
      const rt = new URLSearchParams(init.body).get("refresh_token")
      spentTokens.push(rt)
      const id = mkId({ sub: "u15", exp: Math.floor(Date.now() / 1000) + 3600 })
      minted.push(id)
      return json(200, { access_token: "at", refresh_token: `rt${spentTokens.length}`, id_token: id, expires_in: 3600 })
    }],
    ["/chat/completions", (url, init) => json(200, { token: init.headers.get("authorization") })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  // the host hands back the same stored bundle every time: it never calls
  // auth.refresh, and never writes the rotation back to its storage
  const stored = {
    type: "oauth", access: "at0", refresh: "rt0", expires: Date.now() - 1000,
    idToken: mkId({ sub: "u15" }), subject: "u15",
  }
  const load = async () => p.auth.loader(async () => stored)
  const first = await (await (await load()).fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })).json()
  const second = await (await (await load()).fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })).json()
  assert.deepEqual(spentTokens, ["rt0"], "the consumed refresh token is presented once, not twice")
  assert.equal(first.token, `Bearer ${minted[0]}`)
  assert.equal(second.token, `Bearer ${minted[0]}`, "the second turn goes out on the renewed sign-in")
})

test("a long day of turns renews from the newest bundle, never from a spent one", async () => {
  // the local clock is the one that says a token is spent, so the day is
  // walked an hour at a time rather than waited out
  const realNow = Date.now
  let NOW = realNow()
  Date.now = () => NOW
  try {
    // Mistral's refresh token is single-use: one a renewal already spent is
    // answered invalid_grant, which is how a chain that renews off a stale
    // bundle shows up
    const spentRefresh = new Set()
    const minted = []
    const f = fakeFetch([
      [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
      ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
      ["/token", (url, init) => {
        const rt = new URLSearchParams(init.body).get("refresh_token")
        if (spentRefresh.has(rt)) return json(400, { error: "invalid_grant" })
        spentRefresh.add(rt)
        const id = mkId({ sub: "chain", exp: Math.floor(NOW / 1000) + 3600 })
        minted.push(id)
        return json(200, { access_token: `at${minted.length}`, refresh_token: `rt${minted.length}`, id_token: id, expires_in: 3600 })
      }],
      ["/chat/completions", (url, init) => json(200, { token: init.headers.get("authorization") })],
    ])
    const p = await createPlugin({ fetchImpl: f })
    // the host hands back the same stored bundle every turn: it has no way to
    // write a renewal back, so the refresh token it holds was spent by the
    // very first one
    const stored = {
      type: "oauth", access: "at0", refresh: "rt0", expires: NOW - 1000,
      idToken: mkId({ sub: "chain" }), subject: "chain",
    }
    const loader = await p.auth.loader(async () => stored)
    for (let turn = 1; turn <= 5; turn++) {
      const res = await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
      assert.equal(res.status, 200, `turn ${turn}`)
      assert.equal((await res.json()).token, `Bearer ${minted[turn - 1]}`, `turn ${turn} went out on the newest bundle`)
      NOW += 61 * 60 * 1000
    }
    assert.equal(minted.length, 5, "one renewal per turn, each off the newest refresh token")
  } finally {
    Date.now = realNow
  }
})

test("remember keeps the host's key under the cap, one key per bundle", () => {
  const f = fakeFetch([])
  const bundle = (n) => ({ type: "oauth", access: `at${n}`, refresh: `rt${n - 1}`, expires: n, idToken: mkId(), subject: "s" })
  const host = bundle(1)
  let previous = host
  for (let n = 2; n <= 80; n++) {
    const renewed = bundle(n)
    _internal.remember(f, renewed, previous)
    previous = renewed
  }
  // more renewals than the map's cap: the tokens spent on the way are never
  // looked up again, so they are dropped rather than left to push the one key
  // the host does look up out of the map
  assert.equal(_internal.currentOidc(f, host).access, "at80")
})

test("newerSession answers with the session file's bundle only when it is this account's and newer", () => {
  const HOUR = 3600_000
  const f = fakeFetch([])
  const stored = { type: "oauth", access: "at1", refresh: "rt1", expires: Date.now() + 2 * HOUR, idToken: mkId({ sub: "a" }), subject: "a" }
  _internal.saveSession(f, stored)
  const older = { type: "oauth", access: "at0", refresh: "rt0", expires: Date.now() + HOUR, idToken: mkId({ sub: "a" }), subject: "a" }
  assert.equal(_internal.newerSession(f, older), stored, "the file's is the one whose refresh token is unspent")
  const noSubject = { type: "oauth", access: "at0b", refresh: "rt0b", expires: Date.now() + HOUR, idToken: mkId({ sub: "a" }) }
  assert.equal(_internal.newerSession(f, noSubject), stored, "the ID token's subject answers for a host that dropped the field")
  assert.equal(_internal.newerSession(f, stored), stored)
  const newer = { type: "oauth", access: "at2", refresh: "rt2", expires: Date.now() + 3 * HOUR, idToken: mkId({ sub: "a" }), subject: "a" }
  assert.equal(_internal.newerSession(f, newer), newer, "a newer sign-in is not shadowed by the file")
  const other = { type: "oauth", access: "at9", refresh: "rt9", expires: Date.now() + 4 * HOUR, idToken: mkId({ sub: "b" }), subject: "b" }
  assert.equal(_internal.newerSession(f, other), other, "another account's session is never sent in its place")
  const key = { type: "api", key: "k" }
  assert.equal(_internal.newerSession(f, key), key)
})

test("a session file another process advanced past the cached bundle is read again", () => {
  const f = fakeFetch([])
  const cached = { type: "oauth", access: "at1", refresh: "rt1", expires: 1000, idToken: mkId({ sub: "a" }), subject: "a" }
  _internal.saveSession(f, cached)
  // the file on disk moved on without this process: another host renewed the
  // chain, and the refresh token the cached bundle holds was spent by it
  const fresh = { type: "oauth", access: "at2", refresh: "rt2", expires: 9e15, idToken: mkId({ sub: "a" }), subject: "a" }
  writeFileSync(_internal.sessionPath(), JSON.stringify(fresh))
  assert.deepEqual(_internal.loadSession(f), fresh)
  assert.equal(_internal.newerSession(f, { ...cached, access: "at0" }).access, "at2")
})

test("a restart answers from the session file, spending no refresh token", async () => {
  // one Mistral behind two plugin instances: the second is a process that
  // started after the first one's renewals, with the same account storage
  const spentRefresh = new Set()
  const minted = []
  const routes = () => [
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/token", (url, init) => {
      const rt = new URLSearchParams(init.body).get("refresh_token")
      if (spentRefresh.has(rt)) return json(400, { error: "invalid_grant" })
      spentRefresh.add(rt)
      const id = mkId({ sub: "again", exp: Math.floor(Date.now() / 1000) + 3600 })
      minted.push(id)
      return json(200, { access_token: `at${minted.length}`, refresh_token: `rt${minted.length}`, id_token: id, expires_in: 3600 })
    }],
    ["/chat/completions", (url, init) => json(200, { token: init.headers.get("authorization") })],
  ]
  const stored = {
    type: "oauth", access: "at0", refresh: "rt0", expires: Date.now() - 1000,
    idToken: mkId({ sub: "again" }), subject: "again",
  }
  const turn = async (p) =>
    (await (await p.auth.loader(async () => stored)).fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })).json()

  const first = await createPlugin({ fetchImpl: fakeFetch(routes()) })
  assert.equal((await turn(first)).token, `Bearer ${minted[0]}`)
  // the renewal is kept where a restart can find it
  const file = JSON.parse(readFileSync(_internal.sessionPath(), "utf8"))
  assert.equal(file.refresh, "rt1")
  assert.equal(file.idToken, minted[0])

  // the restart: nothing in memory, and the account storage still holds the
  // sign-in's bundle — whose refresh token the first run already spent
  const second = await createPlugin({ fetchImpl: fakeFetch(routes()) })
  assert.equal((await turn(second)).token, `Bearer ${minted[0]}`)
  assert.equal(minted.length, 1, "the restart renewed nothing: the file held a usable bundle")
})

test("a session file that cannot be written leaves the turn working", async () => {
  // A file where the parent directory should be: mkdir and the lock both
  // fail, without writing anything outside the test's own home.
  const blocker = join(EMPTY_VIBE_HOME, "not-a-directory")
  writeFileSync(blocker, "")
  process.env.VIBE_SESSION_FILE = join(blocker, "session.json")
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/token", () => json(200, { access_token: "at", refresh_token: "rt1", id_token: mkId({ sub: "ro" }), expires_in: 3600 })],
    ["/chat/completions", (url, init) => json(200, { token: init.headers.get("authorization") })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at0", refresh: "rt0", expires: Date.now() - 1000,
    idToken: mkId({ sub: "ro" }), subject: "ro",
  }))
  const res = await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
  assert.equal(res.status, 200)
})

test("callbackServer gives the loopback port back when the browser turns the sign-in down", async () => {
  // a free port, held just long enough to learn its number
  const squatter = createServer()
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r))
  const port = squatter.address().port
  await new Promise((r) => squatter.close(r))
  const uri = `http://127.0.0.1:${port}/callback`

  // the rejection is held from the first moment, so a turn-down is never an
  // unhandled one while the test waits for it
  const waiting = _internal.callbackServer(uri, "state-1").catch((e) => e)
  await fetch(`${uri}?error=access_denied&state=state-1`).catch(() => {})
  const err = await waiting
  assert.match(err.message, /access_denied/)

  // the port is listenable again: the next sign-in in this process is not
  // told the CLI is squatting it
  await new Promise((r) => setTimeout(r, 20))
  const again = createServer()
  await new Promise((resolve, reject) => { again.once("error", reject); again.listen(port, "127.0.0.1", resolve) })
  await new Promise((r) => again.close(r))
})

test("usage on the OIDC account reads the sign-in state and reports the user", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/model-catalog", () => json(200, { models: [{ id: "mistral-large-4-0", label: "Mistral Large 4" }] })],
    ["/models", () => json(200, { data: [{ id: "codestral-latest" }] })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u3", exp: Math.floor(Date.now() / 1000) + 3600, email: "me@x.y" }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u3",
    email: "me@x.y",
  }))
  assert.equal(out.user, "me@x.y")
  assert.deepEqual(out.windows, [])
})

test("usage marks an OIDC account expired when the platform refuses its tokens", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(401, {})],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u4", exp: Math.floor(Date.now() / 1000) + 3600 }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u4",
  }))
  assert.equal(out.signIn, "expired")
})

test("refused refresh inside usage marks the account expired", async () => {
  const f = fakeFetch([
    ["/token", () => json(400, { error: "invalid_grant" })],
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() - 1000,
    idToken: mkId({ sub: "u5", exp: Math.floor(Date.now() / 1000) - 10 }),
    idExpires: (Math.floor(Date.now() / 1000) - 10) * 1000,
    subject: "u5",
  }))
  assert.equal(out.signIn, "expired")
})

test("usage keeps the account's identity when the model tables answer nothing", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/model-catalog", () => json(200, { models: [] })],
    ["/models", () => json(200, { data: [] })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u9", exp: Math.floor(Date.now() / 1000) + 3600, email: "me@x.y" }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u9", email: "me@x.y",
  }))
  assert.equal(out.user, "me@x.y")
  assert.match(out.error, /no model list/)
})

test("budgetWindow reads the month the reset closes, and the usual month without one", () => {
  assert.deepEqual(
    _internal.budgetWindow({ usage_percentage: 40, reset_at: "2026-03-01T00:00:00Z" }, "Vibe Code"),
    { name: "Vibe Code", used: 40, span: 2419200, resetsAt: "2026-03-01T00:00:00Z" },
  )
  // no reset to read back a month from: the window keeps the usual month
  assert.deepEqual(
    _internal.budgetWindow({ usage_percentage: 2.30805 }, "API"),
    { name: "API", used: 2.30805, span: 2592000 },
  )
  assert.equal(_internal.budgetWindow(null, "API"), undefined)
  assert.equal(_internal.budgetWindow({}, "API"), undefined)
})

test("usage on the OIDC account reports the plan and both quota windows", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/model-catalog", () => json(200, { models: [] })],
    ["/models", () => json(200, { data: [{ id: "codestral-latest" }] })],
    ["/billing/subscription", () => json(200, { plan_name: "TEAM", vibe_payg_enabled: true })],
    ["/billing/budget", () => json(200, {
      vibe_budget: { usage_percentage: 40, initial_budget: 100, reset_at: "2026-03-01T00:00:00Z" },
      api_budget: { usage_percentage: 2.30805, initial_budget: 10, reset_at: "2026-12-01T00:00:00Z" },
    })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u20", exp: Math.floor(Date.now() / 1000) + 3600, email: "me@x.y" }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u20",
    email: "me@x.y",
  }))
  assert.equal(out.user, "me@x.y")
  assert.equal(out.plan, "TEAM")
  assert.deepEqual(out.windows, [
    { name: "Vibe Code", used: 40, span: 2419200, resetsAt: "2026-03-01T00:00:00Z" },
    { name: "API", used: 2.30805, span: 2592000, resetsAt: "2026-12-01T00:00:00Z" },
  ])
})

test("usage keeps the sign-in when the budget read is refused", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/model-catalog", () => json(200, { models: [] })],
    ["/models", () => json(200, { data: [{ id: "codestral-latest" }] })],
    ["/billing/subscription", () => json(200, { plan_name: "TEAM" })],
    // the budget needs the see_org_inference_usage permission: a 403 here
    // is a missing permission, not a refused credential
    ["/billing/budget", () => json(403, {})],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u21", exp: Math.floor(Date.now() / 1000) + 3600, email: "me@x.y" }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u21",
    email: "me@x.y",
  }))
  assert.equal(out.user, "me@x.y")
  assert.equal(out.plan, "TEAM")
  assert.deepEqual(out.windows, [])
  assert.equal(out.signIn, undefined)
})

test("usage reports the windows when the subscription read fails", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/model-catalog", () => json(200, { models: [] })],
    ["/models", () => json(200, { data: [{ id: "codestral-latest" }] })],
    ["/billing/subscription", () => json(500, {})],
    ["/billing/budget", () => json(200, {
      vibe_budget: { usage_percentage: 40, initial_budget: 100, reset_at: "2026-12-01T00:00:00Z" },
    })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u22", exp: Math.floor(Date.now() / 1000) + 3600, email: "me@x.y" }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u22",
    email: "me@x.y",
  }))
  assert.equal(out.plan, undefined)
  assert.deepEqual(out.windows, [{ name: "Vibe Code", used: 40, span: 2592000, resetsAt: "2026-12-01T00:00:00Z" }])
})

test("usage on a pasted key reports the quota windows beside the key's state", async () => {
  const f = fakeFetch([
    ["/model-catalog", () => json(200, { models: [] })],
    ["/models", () => json(200, { data: [{ id: "codestral-latest" }] })],
    ["/billing/subscription", () => json(200, { plan_name: "FREE" })],
    ["/billing/budget", () => json(200, {
      vibe_budget: { usage_percentage: 40, initial_budget: 10, reset_at: "2026-12-01T00:00:00Z" },
      api_budget: { usage_percentage: 2.30805, initial_budget: 10, reset_at: "2026-12-01T00:00:00Z" },
    })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const out = await p.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.equal(out.plan, "FREE")
  assert.deepEqual(out.windows, [
    { name: "Vibe Code", used: 40, span: 2592000, resetsAt: "2026-12-01T00:00:00Z" },
    { name: "API", used: 2.30805, span: 2592000, resetsAt: "2026-12-01T00:00:00Z" },
  ])
})

test("provider.models reads the tables with the OIDC tenant headers, catalog first", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/model-catalog", () => json(200, {
      models: [{ id: "mistral-large-4-0", label: "Mistral Large 4", max_context_length: 1048576, parameters: { reasoning: ["low", "medium", "high"] }, capabilities: { completion_chat: true, function_calling: true, vision: true } }],
    })],
    ["/models", () => json(200, { data: [{ id: "codestral-latest" }] })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const rows = await p.provider.models({ models: { kept: true } }, { auth: {
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u10", exp: Math.floor(Date.now() / 1000) + 3600 }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u10",
  } })
  // the plan's own pick first, then the account's list
  assert.deepEqual(Object.keys(rows), ["mistral-large-4-0", "codestral-latest"])
  // and the catalog's metadata fills the row
  assert.equal(rows["mistral-large-4-0"].name, "Mistral Large 4")
  assert.equal(rows["mistral-large-4-0"].limit.context, 1048576)
  assert.deepEqual(Object.keys(rows["mistral-large-4-0"].variants), ["low", "medium", "high"])
  assert.equal(rows["mistral-large-4-0"].capabilities.attachment, true)
  // every table read carried the workspace headers the gateway requires
  for (const call of f.seen.filter((c) => c.url.includes("/models") || c.url.includes("/model-catalog")))
    assert.equal(call.init.headers["x-external-organization-id"], "o1")
})

test("provider.models marks the account expired when a table is refused", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/models", () => json(401, {})],
  ])
  const p = await createPlugin({ fetchImpl: f })
  await assert.rejects(() => p.provider.models({ models: {} }, { auth: {
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000,
    idToken: mkId({ sub: "u11", exp: Math.floor(Date.now() / 1000) + 3600 }),
    idExpires: (Math.floor(Date.now() / 1000) + 3600) * 1000,
    subject: "u11",
  } }), (e) => e.signIn === "expired")
})

test("the first sign-in is persisted and its home directory is created", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-first-signin-"))
  process.env.VIBE_HOME = join(root, "does-not-exist-yet")
  process.env.VIBE_SESSION_FILE = join(process.env.VIBE_HOME, "nested", "session.json")
  const idToken = mkId({ sub: "first-signin" })
  try {
    _internal.saveSession(fakeFetch([]), {
      access: "at0", refresh: "rt0", idToken,
      expires: Date.now() + 3600_000, idExpires: Date.now() + 3600_000,
      subject: "first-signin", email: "me@x.y",
    })
    const file = JSON.parse(readFileSync(_internal.sessionPath(), "utf8"))
    assert.equal(file.refresh, "rt0")
    assert.equal(file.idToken, idToken)
    if (process.platform !== "win32")
      assert.equal(statSync(_internal.sessionPath()).mode & 0o777, 0o600)
    assert.equal(_internal.loadSession(fakeFetch([])).subject, "first-signin")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("two plugin instances renewing one session spend one refresh token", async () => {
  const spent = new Set()
  let tokenCalls = 0
  let chats = 0
  const backend = async (url, init) => {
    url = String(url)
    if (url.includes(".well-known")) return json(200, {
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token",
    })
    if (url.includes("/token")) {
      const rt = new URLSearchParams(init.body).get("refresh_token")
      if (spent.has(rt)) return json(400, { error: "invalid_grant" })
      spent.add(rt)
      tokenCalls++
      return json(200, {
        access_token: `at${tokenCalls}`, refresh_token: `rt${tokenCalls}`,
        id_token: mkId({ sub: "race" }), expires_in: 3600,
      })
    }
    if (url.includes("/users/me/workspaces")) return json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })
    if (url.includes("/chat/completions")) {
      chats++
      return json(200, { ok: true })
    }
    return json(404, {})
  }
  const p1 = await createPlugin({ fetchImpl: (url, init) => backend(url, init) })
  const p2 = await createPlugin({ fetchImpl: (url, init) => backend(url, init) })
  const stored = {
    type: "oauth", access: "at0", refresh: "rt0",
    expires: Date.now() - 1000, idToken: mkId({ sub: "race" }), subject: "race",
  }
  const call = async (p) => {
    const loader = await p.auth.loader(async () => stored)
    return (await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })).status
  }
  const statuses = await Promise.all([call(p1), call(p2)])
  assert.deepEqual(statuses, [200, 200])
  assert.equal(tokenCalls, 1, "the shared refresh token was spent once")
  assert.equal(chats, 2)
})

test("a stale session lock directory is taken over", async () => {
  const lock = `${_internal.sessionPath()}.lock`
  mkdirSync(lock, { mode: 0o700 })
  writeFileSync(join(lock, "owner"), "stale")
  utimesSync(lock, new Date(0), new Date(0))
  let tokenCalls = 0
  const f = fakeFetch([
    [".well-known", () => json(200, { authorization_endpoint: "a", token_endpoint: "https://auth.example/token" })],
    ["/token", () => { tokenCalls++; return json(200, { access_token: "at1", refresh_token: "rt1", id_token: mkId({ sub: "stale-lock" }), expires_in: 3600 }) }],
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/chat/completions", () => json(200, { ok: true })],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at0", refresh: "rt0",
    expires: Date.now() - 1000, idToken: mkId({ sub: "stale-lock" }), subject: "stale-lock",
  }))
  const res = await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
  assert.equal(res.status, 200)
  assert.equal(tokenCalls, 1)
  assert.throws(() => statSync(lock), (e) => e.code === "ENOENT")
})

test("a Request body is replayed after a 401", async () => {
  let tokenCalls = 0
  let chats = 0
  const f = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes(".well-known")) return json(200, {
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token",
    })
    if (url.includes("/token")) {
      tokenCalls++
      return json(200, { access_token: "at1", refresh_token: "rt1", id_token: mkId({ sub: "request-retry" }), expires_in: 3600 })
    }
    if (url.includes("/users/me/workspaces")) return json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })
    if (url.includes("/chat/completions")) {
      chats++
      assert.ok(input instanceof Request, "the Request itself goes out")
      assert.equal(await input.text(), '{"hello":"world"}')
      return json(chats === 1 ? 401 : 200, { ok: true })
    }
    return json(404, {})
  }
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at0", refresh: "rt0",
    expires: Date.now() + 3600_000, idToken: mkId({ sub: "request-retry" }), subject: "request-retry",
  }))
  const res = await loader.fetch(new Request(`${_internal.BASE}/chat/completions`, {
    method: "POST", body: '{"hello":"world"}', headers: { "content-type": "application/json" },
  }))
  assert.equal(res.status, 200)
  assert.equal(chats, 2)
  assert.equal(tokenCalls, 1)
})

test("a caller's abort is rethrown instead of becoming a gateway error", async () => {
  const f = async (url) => {
    if (String(url).includes("/users/me/workspaces"))
      return json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })
    if (String(url).includes("/chat/completions")) throw new DOMException("aborted by caller", "AbortError")
    return json(404, {})
  }
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000, idToken: mkId({ sub: "abort" }), subject: "abort",
  }))
  await assert.rejects(
    () => loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST", signal: AbortSignal.abort() }),
    (e) => e.name === "AbortError",
  )
})

test("authorize handles a callback-server failure before the host calls callback", async () => {
  const squatter = createServer()
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r))
  const port = squatter.address().port
  process.env.VIBE_CLI_OIDC_REDIRECT_URI = `http://127.0.0.1:${port}/callback`
  const f = fakeFetch([[".well-known", () => json(200, {
    authorization_endpoint: "https://auth.example/authorize",
    token_endpoint: "https://auth.example/token",
  })]])
  const p = await createPlugin({ fetchImpl: f })
  let unhandled
  const onUnhandled = (e) => { unhandled = e }
  process.on("unhandledRejection", onUnhandled)
  try {
    const flow = await p.auth.methods[0].authorize()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(unhandled, undefined)
    const result = await flow.callback()
    assert.equal(result.type, "failed")
  } finally {
    process.off("unhandledRejection", onUnhandled)
    await new Promise((r) => squatter.close(r))
  }
})

test("modelTable excludes embedding, OCR and catalog non-chat entries", async () => {
  const f = fakeFetch([
    ["/model-catalog", () => json(200, { models: [
      { id: "chat-a", capabilities: { completion_chat: true } },
      { id: "hidden-a", capabilities: { completion_chat: false } },
    ] })],
    ["/models", () => json(200, { data: [
      { id: "chat-a" }, { id: "mistral-embed" }, { id: "mistral-ocr-latest" },
      { id: "hidden-a" }, { id: "chat-b" },
    ] })],
  ])
  const table = await _internal.modelTable(f, {})
  assert.deepEqual(table.ids, ["chat-a", "chat-b"])
})

test("modelTable limits a plan account to catalog and verified bootstrap ids", async () => {
  const f = fakeFetch([
    ["/model-catalog", () => json(200, { models: [
      { id: "catalog-chat", capabilities: { completion_chat: true } },
      { id: "hidden-chat", capabilities: { completion_chat: false } },
    ] })],
    ["/models", () => json(200, { data: [
      { id: "catalog-chat" }, { id: "codestral-latest" },
      { id: "devstral-medium-latest" }, { id: "mistral-large-latest" },
      { id: "hidden-chat" }, { id: "new-chat" },
    ] })],
  ])
  const table = await _internal.modelTable(f, {}, { plan: true })
  assert.deepEqual(table.ids, ["catalog-chat", "codestral-latest"])
  const open = await _internal.modelTable(f, {})
  assert.ok(open.ids.includes("devstral-medium-latest"))
  assert.ok(open.ids.includes("new-chat"))
})

test("the last plan catalog still filters an account when a later read fails", async () => {
  let catalogDown = false
  const f = async (url) => {
    if (String(url).includes("/model-catalog"))
      return catalogDown ? json(500, {}) : json(200, { models: [{ id: "catalog-chat" }] })
    if (String(url).includes("/models"))
      return json(200, { data: [{ id: "catalog-chat" }, { id: "devstral-medium-latest" }] })
    return json(404, {})
  }
  assert.deepEqual((await _internal.modelTable(f, {}, { plan: true })).ids, ["catalog-chat"])
  catalogDown = true
  assert.deepEqual((await _internal.modelTable(f, {}, { plan: true })).ids, ["catalog-chat"])
})

test("budgetWindow keeps month-end cycles and drops an invalid reset", () => {
  assert.deepEqual(
    _internal.budgetWindow({ usage_percentage: 1, reset_at: "2026-03-31T00:00:00Z" }, "Vibe Code"),
    { name: "Vibe Code", used: 1, span: 31 * 86400, resetsAt: "2026-03-31T00:00:00Z" },
  )
  const invalid = _internal.budgetWindow({ usage_percentage: 1, reset_at: "not-a-date" }, "API")
  assert.equal(invalid.span, 30 * 86400)
  assert.equal("resetsAt" in invalid, false)
})

test("redirectUriOf only accepts an explicit loopback http port", () => {
  for (const raw of ["http://0.0.0.0:8766/callback", "https://127.0.0.1:8766/callback", "http://127.0.0.1/callback", "http://127.0.0.1:0/callback", "not a url"]) {
    process.env.VIBE_CLI_OIDC_REDIRECT_URI = raw
    assert.throws(() => _internal.redirectUriOf())
  }
  process.env.VIBE_CLI_OIDC_REDIRECT_URI = "http://localhost:8766/callback"
  assert.equal(_internal.redirectUriOf(), "http://localhost:8766/callback")
})

test("resolveApiKey accepts export syntax and a BOM", () => {
  const home = mkdtempSync(join(tmpdir(), "vibe-env-"))
  process.env.VIBE_HOME = home
  writeFileSync(join(home, ".env"), '\uFEFFexport MISTRAL_API_KEY="from-export"\n')
  try {
    assert.equal(_internal.resolveApiKey(), "from-export")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("auth.refresh surfaces a refused sign-in but keeps transient failures quiet", async () => {
  const discovery = () => json(200, {
    authorization_endpoint: "https://auth.example/authorize",
    token_endpoint: "https://auth.example/token",
  })
  const auth = {
    type: "oauth", access: "at0", refresh: "rt0",
    expires: Date.now() - 1000, idToken: mkId({ sub: "refresh-error" }), subject: "refresh-error",
  }
  const refused = await createPlugin({ fetchImpl: fakeFetch([
    [".well-known", discovery],
    ["/token", () => json(400, { error: "invalid_grant" })],
  ]) })
  await assert.rejects(() => refused.auth.refresh(auth), (e) => e.signIn === "expired")

  const transient = await createPlugin({ fetchImpl: fakeFetch([
    [".well-known", discovery],
    ["/token", () => { throw new Error("dns") }],
  ]) })
  assert.equal(await transient.auth.refresh(auth), undefined)
})

test("a JWKS outage does not spend the single-use refresh token", async () => {
  let tokenCalls = 0
  const f = fakeFetch([
    [".well-known", () => json(200, {
      issuer: _internal.ISSUER,
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token",
      jwks_uri: "https://auth.example/jwks",
    })],
    ["/jwks", () => json(500, {})],
    ["/token", () => { tokenCalls++; return json(200, BUNDLE()) }],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const loader = await p.auth.loader(async () => ({
    type: "oauth", access: "at0", refresh: "rt0",
    expires: Date.now() - 1000, idToken: mkId({ sub: "jwks-down" }), subject: "jwks-down",
  }))
  const res = await loader.fetch(`${_internal.BASE}/chat/completions`, { method: "POST" })
  assert.equal(res.status, 502)
  assert.equal(tokenCalls, 0)
})

test("a 403 model refusal is a permission problem, not an expired sign-in", async () => {
  const f = fakeFetch([
    ["/users/me/workspaces", () => json(200, { workspaces: [{ id: "w1", organization_id: "o1" }] })],
    ["/model-catalog", () => json(403, {})],
    ["/models", () => json(403, {})],
  ])
  const p = await createPlugin({ fetchImpl: f })
  const auth = {
    type: "oauth", access: "at", refresh: "rt",
    expires: Date.now() + 3600_000, idToken: mkId({ sub: "forbidden" }), subject: "forbidden",
  }
  const usage = await p.auth.usage(async () => auth)
  assert.equal(usage.signIn, undefined)
  assert.match(usage.error, /403/)
  await assert.rejects(
    () => p.provider.models({ models: {} }, { auth }),
    (e) => e.signIn === undefined && /403/.test(e.message),
  )
})
