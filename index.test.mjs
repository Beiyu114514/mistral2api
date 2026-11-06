import { test as nodeTest } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VibePlugin, _internal } from "./index.mjs"

const createPlugin = _internal.createPlugin

// Every test in this file runs inside its own environment snapshot. A
// developer's own MISTRAL_API_KEY — or their ~/.vibe/.env — must not turn a
// test green or red, and no test may leave a variable behind for the next
// one: each starts from the same empty VIBE_HOME and gets its snapshot back.
// The wrapper shadows the runner's own test on purpose, so a test cannot
// forget to be isolated.
const EMPTY_VIBE_HOME = mkdtempSync(join(tmpdir(), "vibe-test-"))
const KEYS = /^(MISTRAL_|VIBE_)/
const test = (name, fn) =>
  nodeTest(name, async () => {
    const saved = { ...process.env }
    for (const k of Object.keys(process.env)) if (KEYS.test(k)) delete process.env[k]
    process.env.VIBE_HOME = EMPTY_VIBE_HOME
    try {
      return await fn()
    } finally {
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
