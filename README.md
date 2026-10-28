# Evolution Go WhatsApp MCP for Cloudflare

This Worker exposes every operation published by the live Evolution Go Swagger description, plus a read-only tool for messages stored by this project's Supabase webhook. On 2026-10-28, the deployed API description returned 77 operations across calls, chats, communities, groups, instances, labels, licenses, messages, newsletters, passkeys, polls, sending, and users. The Worker never accepts a caller-supplied host or URL: Evolution API calls are pinned to the existing Render service.

## What it can do

- `evolution_api_catalog`: discovers the exact routes, operations, and input schemas published by the deployed Evolution Go server. Filter it with terms such as `send`, `group`, `chat`, `user`, `instance`, or `label`.
- `evolution_connection_status`: safely checks the Evolution API status and lists the feature categories available from its live API description.
- `call_evolution_api`: invokes one exact operation ID from that catalogue. It covers the operations in the deployed OpenAPI description, including sending messages and managing groups, chats, contacts, instances, labels, communities, newsletters, polls, passkeys, and other published API features. State changes require `confirm_write: true` after the user explicitly approves that particular action. Routes documented as read-only lookups remain read-only even when Evolution Go uses HTTP POST for them.
- `whatsapp_saved_incoming_messages`: reads only incoming message rows captured by the existing Supabase webhook. It cannot retrieve messages from before the webhook was installed or while Evolution Go was offline.

The Worker does not keep the Evolution Go service awake or preserve its WhatsApp connection when Render sleeps. It is a secure API bridge, not an always-on WhatsApp session host.

`GET /healthz` checks whether OAuth, the essential API keys, and Evolution Go's public API description are available. It returns only a generic `ready` or `needs_configuration` status and whether the API description can be reached; it never returns a credential or its value.

## Prepare the Supabase message reader

The existing webhook table has RLS enabled and no direct read policy. Keep it that way. This function reads the table on the server using Supabase's built-in server key, checks a separate long random secret on every request, and returns at most 100 rows.

1. In the Supabase project's Edge Function Secrets, add `MCP_READ_SHARED_SECRET` with a new long random value. Do not reuse the webhook secret.
2. Add the function below to the Supabase project's `supabase/functions/whatsapp-mcp-read/index.ts`.
3. In the project's `supabase/config.toml`, add:

   ```toml
   [functions.whatsapp-mcp-read]
   verify_jwt = false
   ```

   JWT checking is disabled only because this endpoint uses its own shared-secret header. Do not remove that check from the function.
4. Deploy the function named `whatsapp-mcp-read`. Its URL is `https://<your-project-ref>.supabase.co/functions/v1/whatsapp-mcp-read`.

No database table or row-level security policy change is needed. The Supabase service key stays inside Supabase's Edge Function environment; do not copy it into ChatGPT or expose it in a browser.

## Cloudflare setup

Deploy the entire folder as a Worker project. It uses Cloudflare's maintained Agents MCP handler. A single-file Quick Edit paste is not enough because the project depends on npm packages.

1. The existing Worker is `cloudflare-evolution-mcp`. Deploy this project from the connected GitHub repository or with Wrangler. The Wrangler config binds OAuth storage to the Cloudflare KV namespace `evolution-go-mcp-oauth`.
2. In **Workers & Pages → cloudflare-evolution-mcp → Settings → Variables and Secrets**, add these as **Secret** values (not plain text variables):

   | Secret name | Value to use |
   | --- | --- |
   | `MCP_LOGIN_PASSWORD` | Create a new random password at least 32 characters long. ChatGPT will use it on the OAuth sign-in page. |
   | `MCP_SESSION_SECRET` | A separate random secret at least 32 characters long. It signs the short-lived sign-in cookie. |
   | `EVOLUTION_INSTANCE_TOKEN` | The API token for the connected Evolution Go instance. Use the instance token, not the Supabase database URL/password. |
   | `EVOLUTION_GLOBAL_API_KEY` | The global Evolution Go API key already configured for the Render service. Needed for admin-only instance/license operations. |
   | `WHATSAPP_READ_URL` | The deployed Supabase function URL above. |
   | `WHATSAPP_READ_SECRET` | The same value you created in Supabase as `MCP_READ_SHARED_SECRET`. |

   If you do not need to read stored messages yet, leave both `WHATSAPP_READ_*` secrets unset; the other Evolution API tools still work.
3. The MCP URL is `https://cloudflare-evolution-mcp.mitchel1234special.workers.dev/mcp`. Add it to ChatGPT as a custom MCP server and choose OAuth. During setup, sign in with `MCP_LOGIN_PASSWORD` and approve the required `mcp:read` and `mcp:write` scopes. The Worker needs both to expose all read and write operations; `offline_access` may also be requested so ChatGPT can refresh the connection.

### Where to get the Evolution keys

- The per-instance API token is the credential for the WhatsApp instance. Find it in Evolution Go's instance/API settings or the instance creation response. Keep it private.
- The global key is the same secret used by the Render Evolution Go service's `GLOBAL_API_KEY` environment variable. If Render masks it, generate a replacement and update Render and Cloudflare together; do not send it in a message.
- Never use `POSTGRES_AUTH_DB` or `POSTGRES_USERS_DB` here. Those are database connection strings, not Evolution API keys.

## Use and safety

- Start with `evolution_api_catalog` to find the exact tool operation and request fields. Use one API operation at a time.
- `evolution_api_catalog` marks each operation with `requires_write_approval`. For state changes—including sends, group/instance changes, deletes, reactions, read receipts, and license operations—get the user's clear approval of the specific action, then call with `confirm_write=true`. Some documented lookups use POST, while a few stateful endpoints use GET, so follow the catalogue flag rather than the HTTP verb.
- Messages sent through Evolution Go can reach real people. Use only for the intended recipient and content the user requested. Avoid unsolicited bulk messaging, adding people to groups without their permission, and attempts to evade WhatsApp's limits; those can lead to account restrictions.
- The current webhook stores incoming text messages after it is enabled. It ignores outgoing messages and non-message events. `whatsapp_saved_incoming_messages` therefore does not show outgoing messages, media contents, old history, or messages missed during downtime.
- Replace any previously exposed API keys, delete their plain-text Worker Variables, and re-add the rotated values as **Secrets** before using the MCP.

## Source

The API catalogue is read at runtime from `https://evolution-go-x7li.onrender.com/swagger/doc.json` and cached in a Worker isolate for five minutes. If the deployed service does not expose that Swagger JSON URL, `evolution_api_catalog` will return a clear error; the public Swagger UI is at `https://evolution-go-x7li.onrender.com/swagger/index.html`.
