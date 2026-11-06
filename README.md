# @magpie-community/opencode-vibe-auth

Signs in to a Mistral Vibe plan — the account the `vibe` CLI uses — and makes
its requests, in OpenCode and in magpie. Provider id: `vibe`.

Shaped after the community [`river`](https://github.com/magpie-community/plugins/tree/main/packages/river)
package, with [`@magpie-community/opencode-devin-auth`](https://github.com/magpie-community/plugins/tree/main/packages/devin)
as the deeper reference. Unlike Devin, the vibe CLI's model traffic is the
**plain Mistral La Plateforme chat completions API** — confirmed from the
open-source CLI (`mistralai/mistral-vibe`): the harness calls
`client.chat.stream_async` with `api_base` defaulting to
`https://api.mistral.ai/v1` and `Authorization: Bearer`. So requests are not
re-shaped: `@ai-sdk/openai-compatible` serves them, the way river's does.

## Signing in

Choose **Mistral Vibe plan (browser sign in)**: the plugin runs the vibe CLI's
own OIDC sign-in — the same client registration
(`829da7e7-…`, audience `https://api.mistral.ai`), PKCE, and loopback redirect
`http://127.0.0.1:8766/callback`, all read from the open-source CLI. The
tokens are stored with OpenCode's and magpie's own account storage — the
CLI's keyring is not read; sign-in here is its own session — and every
renewal is kept in a file of the plugin's own beside it, so the session
survives a restart instead of asking to be redone.

Requests carry the **ID token** beside the workspace headers the platform
gateway requires (`x-external-organization-id`, `x-external-workspace-id`,
discovered at `GET /v1/users/me/workspaces` with the token). Those headers
are not optional: `/v1/models` answers **401** without them. That is what
spends the plan's quota — verified end to end on a real plan account.

`VIBE_CLI_OIDC_ORGANIZATION_ID` / `VIBE_CLI_OIDC_WORKSPACE_ID` pick an
explicit workspace, as the CLI's own env overrides do. If the port is taken
(the CLI running its own sign-in), set `VIBE_CLI_OIDC_REDIRECT_URI`.

Paste a **Mistral API key** for the plain platform account instead — that
one spends API balances, not the plan. Without a pasted key the plugin
resolves one the way the vibe CLI resolves its own: `MISTRAL_API_KEY` (or
`VIBE_API_KEY_ENV_VAR` for another env var name), then `$VIBE_HOME/.env`
(`~/.vibe/.env` by default).

## Models

Two tables are read, the way the CLI reads them: `/model-catalog?surface=vibe-code`
(the plan's own picks — `mistral-large-4-0`, `mistral-medium-latest`, with
their limits, vision and reasoning efforts) first, then the account's
`GET /v1/models`. A bootstrap list starts the config hook and fills the rows
the tables don't describe; every id in it answered a real chat turn on a plan
account. Models outside the plan (`devstral-*`, `mistral-large-latest`) are
left out — the platform answers them with `tier_not_allowed`.

## Quota windows

The account's allowances are read the way the vibe CLI's footer reads them:
`/v1/billing/subscription` for the plan, `/v1/billing/budget` for the
monthly Vibe Code allowance beside the platform balance. Both windows are
shown — `usage_percentage` arrives already in percent, the 0.3744 the API
answers is the $0.04 of $10 the admin console shows — the window closes at
Mistral's own reset, and both reads are optional: a platform that does not
serve them, or an account without the `see_org_inference_usage` permission
the budget needs, shows no windows and says nothing about the sign-in.

## The session outlives the process

A renewal is written to the plugin's own session file,
`.opencode-vibe-session.json` beside the CLI's config (`~/.vibe/` by default,
`VIBE_HOME` to move it, `VIBE_SESSION_FILE` to name the file outright),
alongside the host's account storage. OpenCode gives a plugin no way to
write its storage back and never calls `auth.refresh`, so without the file a
restart would present the sign-in's refresh token — which the first renewal
had already spent — and be answered `invalid_grant` on its first request.
The file is read back whenever the host's bundle is no longer the newest
one, and a sign-in for another account is never answered from it. It is
written beside its target and moved into place, so a reader never sees half
a file, and a path that cannot be written changes nothing about the request
path: the renewals of the running process still work.

## Two things worth knowing about Mistral's OIDC

- **The ID token's `exp` claim is 8 hours behind UTC.** `auth.mistral.ai`
  stamps its tokens on a Pacific clock, so a freshly exchanged ID token
  arrives with an `exp` already in the past — while the platform serves it
  for its full hour. Staleness is therefore read off the access token's
  `expires_in` alone, the way the CLI reads it; trusting the claim would
  spend a refresh on every call.
- **The refresh token is single-use and rotates.** Every renewal spends the
  one it was given and hands back a new one, so a session is a chain, and
  the host's storage still holds the bundle the first renewal superseded —
  presenting its spent token again is answered `invalid_grant`. The newest
  bundle is therefore tracked per process, one renewal before a request and
  one more only if the platform turns the first token away, and kept in the
  session file so a restart continues the chain rather than starting over.
  A refresh that is refused outright still means sign in again, as it does
  for the CLI.

## Chat turns are bounded

One turn is one request that may run for minutes, so it carries a ceiling of
its own: five minutes, the same wait undici applies, set it with
`VIBE_TURN_TIMEOUT_MS`. A connection the platform accepts and never answers
is reported instead of hanging the turn with no error and no cancellation,
and a signal the host passes is honoured instead of it.

## Live check

`scripts/live.mjs` runs the sign-in against real Mistral and prints what
came back — nothing is stored:

```sh
node scripts/live.mjs --start                       # prints the browser URL
node scripts/live.mjs --url "<the redirect URL>"    # exchanges, then probes
node scripts/live.mjs --explore                     # probes the saved bundle again
```

The browser that signs in is usually not the machine the plugin runs on, so
the redirect lands on a page that will not load: copy the URL out of the
address bar — it carries the code — and pass it to `--url`. Sign in with a
fresh browser session: an ID token minted for an hours-old session can come
back already expired.

## Verified, and what is not

Verified on one plan account (2026-11-06): the OIDC exchange, workspace
discovery, `/v1/models` and the vibe-code catalog behind the tenant headers,
the billing reads behind the same headers, the renewal chain across five
turns an hour apart, and a restart — a second process answered from the
session file with the account storage still holding the spent bundle, and
spent no refresh token to do it — and chat completions on `mistral-large-4-0`, `mistral-medium-latest`, the
three `mistral-vibe-cli-*`, `codestral-2508`/`codestral-latest`,
`mistral-code-latest`, `mistral-code-fim-latest`, `magistral-medium-latest`,
`mistral-small-latest`, `ministral-14b/8b/3b-latest` and
`voxtral-small-latest`.

Not verified: another account's workspace layout, the budget reads on a paid
plan (the verified account is FREE, with a $10 monthly allowance), a session
left idle for days (the renewals verified here were minutes to an hour
apart), and limits taken from Mistral's docs rather than the catalog.

MIT. Not affiliated with Mistral.
