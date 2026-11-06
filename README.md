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
CLI's keyring is not read; sign-in here is its own session.

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

## Not included

No usage windows: the read keeps the sign-in state (a refused credential
marks the account expired and offers a retry).

## Two things worth knowing about Mistral's OIDC

- **The ID token's `exp` claim is 8 hours behind UTC.** `auth.mistral.ai`
  stamps its tokens on a Pacific clock, so a freshly exchanged ID token
  arrives with an `exp` already in the past — while the platform serves it
  for its full hour. Staleness is therefore read off the access token's
  `expires_in` alone, the way the CLI reads it; trusting the claim would
  spend a refresh on every call.
- **The refresh token can be refused** (`invalid_grant`, "can not be
  found"), which the CLI treats as re-login required and so does this
  plugin: the sign-in lasts the access token's hour, then sign in again.
  A refresh token here is single-use, so a turn spends at most one — one
  renewal before the request, and one more only if the platform turns the
  first token away — and the renewal it produced is the one the next
  request goes out on.

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
and chat completions on `mistral-large-4-0`, `mistral-medium-latest`, the
three `mistral-vibe-cli-*`, `codestral-2508`/`codestral-latest`,
`mistral-code-latest`, `mistral-code-fim-latest`, `magistral-medium-latest`,
`mistral-small-latest`, `ministral-14b/8b/3b-latest` and
`voxtral-small-latest`.

Not verified: another account's workspace layout, whether the refresh grant
ever succeeds (it was refused once), and limits taken from Mistral's docs
rather than the catalog.

MIT. Not affiliated with Mistral.
