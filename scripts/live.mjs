// A live check of the Vibe plan sign-in, against real Mistral. The browser
// that signs in is not the machine this runs on, so the sign-in is two
// phases and the tokens are kept between them:
//
//   node scripts/live.mjs --start
//     prints the sign-in URL, saves the PKCE/state/nonce
//
//   node scripts/live.mjs --url "<the full redirect URL from the address bar>"
//     verifies the state, exchanges the code, saves the token bundle, then
//     explores: /v1/models, the vibe-code catalog, and one tiny chat turn
//     per candidate model
//
//   node scripts/live.mjs --explore
//     runs the same exploration again with the saved bundle (refreshed
//     first when it has grown stale)
//
// After approving in the browser the next page will NOT load (the redirect
// points at 127.0.0.1, i.e. your own machine): copy the whole URL out of
// the address bar — it carries the code — and pass it to --url, straight
// away, since authorization codes are short-lived.
//
// Sign in with a FRESH browser session (a private window, or log out of
// Mistral first): the ID token Mistral mints lives as long as the browser
// session, and an old session hands back an ID token that is already
// expired on arrival — the platform then answers 401 and only a re-login
// helps.

import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { _internal } from "../index.mjs"

const STATE_FILE = "/tmp/vibe-live.json"
const TOKEN_FILE = "/tmp/vibe-live-tokens.json"

// models a Vibe plan plausibly serves, from the CLI's own tables
const CANDIDATES = [
  "devstral-medium-latest", "devstral-small-latest", "codestral-latest",
  "magistral-medium-latest", "mistral-small-latest", "ministral-8b-latest",
  "pixtral-large-latest", "open-mistral-nemo", "mistral-medium-latest",
  "mistral-large-latest",
]

// every request under a hard timeout: this sandbox's network can leave a
// connection established and silent, and an abort signal alone does not
// always end the wait
const HARD_MS = 25000
const ask = (url, init = {}) => {
  const work = fetch(url, { ...init, signal: AbortSignal.timeout(HARD_MS) })
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${HARD_MS / 1000}s`)), HARD_MS + 500)
  })
  return Promise.race([work, guard]).finally(() => clearTimeout(timer))
}
const text = async (res) => {
  try {
    return await res.text()
  } catch {
    return "<no body>"
  }
}

const start = async () => {
  const { verifier, challenge } = _internal.pkcePair()
  const state = crypto.randomUUID().replace(/-/g, "")
  const nonce = crypto.randomUUID().replace(/-/g, "")
  writeFileSync(STATE_FILE, JSON.stringify({ verifier, state, nonce, at: Date.now() }))
  const url = await _internal.authorizationUrl(globalThis.fetch, { challenge, state, nonce })
  console.log("open this URL in the browser, sign in with your Vibe plan account and approve:\n")
  console.log(url + "\n")
  console.log("the page that follows will NOT load (it redirects to 127.0.0.1 on your own machine).")
  console.log("copy the FULL URL from the browser's address bar — it contains the code — and run:")
  console.log("  node scripts/live.mjs --url \"<that URL>\"")
  console.log("do it right away, the code is short-lived.")
}

// saved is the token bundle as an auth object freshOidc/oidcHeaders take
const saved = () => {
  const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"))
  return { type: "oauth", ...t }
}

const explore = async (label) => {
  const { a } = await _internal.freshOidc(globalThis.fetch, saved())
  const headers = await _internal.oidcHeaders(globalThis.fetch, a)
  console.log(`\n--- ${label}: subject ${a.subject} (${a.email || "no email"})`)
  console.log("headers sent:", { authorization: `Bearer <id token ${a.idToken.length} chars>`, ...Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "authorization")) })

  const get = async (path) => {
    try {
      const res = await ask(`${_internal.BASE}${path}`, { headers })
      const body = await text(res)
      let ids
      try {
        const parsed = JSON.parse(body)
        ids = Array.isArray(parsed.data) ? parsed.data.map((m) => m.id) : Array.isArray(parsed.models) ? parsed.models.map((m) => m.id) : undefined
      } catch {}
      console.log(`${path} -> HTTP ${res.status}${ids ? ` (${ids.length} entries)` : ""}`)
      if (ids) console.log("  ", ids.join(", "))
      else if (res.status !== 200) console.log("  ", body.slice(0, 200))
      return { status: res.status, ids }
    } catch (e) {
      console.log(`${path} -> failed: ${e?.message ?? e}`)
      return {}
    }
  }
  const models = (await get("/models")).ids ?? []
  await get("/model-catalog?surface=vibe-code")

  // the live lists first, the hardcoded ones after them, deduplicated
  const order = [...new Set([...models, ...CANDIDATES])].slice(0, 12)
  console.log(`\none tiny chat turn per model (max_tokens 8, ${order.length} to try):`)
  for (const model of order) {
    try {
      const res = await ask(`${_internal.BASE}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "say ok" }] }),
      })
      const body = await text(res)
      let why = ""
      try {
        why = JSON.parse(body)?.message ?? ""
      } catch {
        why = body.slice(0, 80)
      }
      console.log(`  ${model.padEnd(26)} HTTP ${res.status}${res.status === 200 ? "  OK " + body.slice(0, 100) : "  " + why.slice(0, 130)}`)
    } catch (e) {
      console.log(`  ${model.padEnd(26)} failed: ${e?.message ?? e}`)
    }
  }
}

const finish = async (redirect) => {
  let savedState
  try {
    savedState = JSON.parse(readFileSync(STATE_FILE, "utf8"))
  } catch {
    throw new Error("no saved sign-in; run: node scripts/live.mjs --start")
  }
  const q = Object.fromEntries(new URL(redirect).searchParams)
  if (q.error) throw new Error(`the browser said: ${q.error_description || q.error}`)
  if (!q.code) throw new Error("that URL has no code in it")
  if (q.state !== savedState.state) throw new Error("state mismatch: that URL belongs to a different sign-in; --start again")
  const t = await _internal.exchangeCode(globalThis.fetch, { code: q.code, verifier: savedState.verifier, nonce: savedState.nonce, redirectUri: _internal.redirectUriOf() })
  console.log("exchange ok:", { subject: t.subject, email: t.email, expires_in: Math.round((t.expires - Date.now()) / 1000) })
  writeFileSync(TOKEN_FILE, JSON.stringify({
    access: t.access, refresh: t.refresh, idToken: t.idToken,
    expires: t.expires, idExpires: t.idExpires, subject: t.subject, email: t.email,
  }))
  rmSync(STATE_FILE, { force: true })
  console.log("token bundle saved to", TOKEN_FILE)
  await explore("fresh sign-in")
}

const arg = process.argv[2]
try {
  if (arg === "--start") await start()
  else if (arg === "--url" && process.argv[3]) await finish(process.argv[3])
  else if (arg === "--explore") await explore("saved bundle")
  else console.log("usage: node scripts/live.mjs --start | --url \"<redirect URL>\" | --explore")
} catch (e) {
  console.error("failed:", e?.message ?? e)
  process.exitCode = 1
}
