# Evolution Go WhatsApp MCP for Cloudflare

This Worker exposes the API operations published by the live Evolution Go Swagger description, plus a read-only tool for messages stored by this project's Supabase webhook. The Worker never accepts a caller-supplied host or URL: Evolution API calls are pinned to the existing Render service.

## What it can do

- `evolution_api_catalog`: discovers the exact routes, operations, and input schemas published by the deployed Evolution Go server. Filter it with terms such as `send`, `group`, `chat`, `user`, `instance`, or `label`.
- `call_evolution_api`: invokes one exact operation ID from that catalogue. It covers the operations in the deployed OpenAPI description, including instance, message, contact, group, chat, label, community, newsletter, and other published API features. Non-GET calls require `confirm_write: true` after the user explicitly approves that particular action.
- `whatsapp_saved_incoming_messages`: reads only incoming message rows captured by the existing Supabase webhook. It cannot retrieve messages from before the webhook was installed or while Evolution Go was offline.

The Worker does not keep the Evolution Go service awake or preserve its WhatsApp connection when Render sleeps. It is a secure API bridge, not an always-on WhatsApp session host.

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

1. Create a GitHub repository for this folder and connect it in Cloudflare Workers & Pages, or deploy the folder using Wrangler from a computer with Node.js installed.
2. Create a Worker named `evolution-go-mcp` and deploy the project.
3. In **Workers & Pages → evolution-go-mcp → Settings → Variables and Secrets**, add these as **Secret** values (not plain text variables):

   | Secret name | Value to use |
   | --- | --- |
   | `MCP_ACCESS_TOKEN` | Make a new long random password. This protects the MCP endpoint. |
   | `EVOLUTION_INSTANCE_TOKEN` | The API token for the connected Evolution Go instance. Use the instance token, not the Supabase database URL/password. |
   | `EVOLUTION_GLOBAL_API_KEY` | The global Evolution Go API key already configured for the Render service. Needed for admin-only instance/license operations. |
   | `WHATSAPP_READ_URL` | The deployed Supabase function URL above. |
   | `WHATSAPP_READ_SECRET` | The same value you created in Supabase as `MCP_READ_SHARED_SECRET`. |

   If you do not need to read stored messages yet, leave both `WHATSAPP_READ_*` secrets unset; the other Evolution API tools still work.
4. Deploy after adding the secrets. The MCP URL is `https://evolution-go-mcp.<your-cloudflare-subdomain>.workers.dev/mcp`. The MCP client must send `Authorization: Bearer <MCP_ACCESS_TOKEN>`. Do not put this token into a URL or paste it into chat.
5. Add that URL to your ChatGPT custom MCP connection and choose the bearer/API-key authentication option if it offers one. If that connection only supports OAuth, this simple shared-token gate will need Cloudflare's OAuth wrapper before it can connect.

### Where to get the Evolution keys

- The per-instance API token is the credential for the WhatsApp instance. Find it in Evolution Go's instance/API settings or the instance creation response. Keep it private.
- The global key is the same secret used by the Render Evolution Go service's `GLOBAL_API_KEY` environment variable. If Render masks it, generate a replacement and update Render and Cloudflare together; do not send it in a message.
- Never use `POSTGRES_AUTH_DB` or `POSTGRES_USERS_DB` here. Those are database connection strings, not Evolution API keys.

## Use and safety

- Start with `evolution_api_catalog` to find the exact tool operation and request fields. Use one API operation at a time.
- For any API operation other than GET, first get the user's clear approval of the specific change/message, then call with `confirm_write=true`.
- Messages sent through Evolution Go can reach real people. Use only for the intended recipient and content the user requested. Avoid unsolicited bulk messaging, adding people to groups without their permission, and attempts to evade WhatsApp's limits; those can lead to account restrictions.
- The current webhook stores incoming text messages after it is enabled. It ignores outgoing messages and non-message events. `whatsapp_saved_incoming_messages` therefore does not show outgoing messages, media contents, old history, or messages missed during downtime.
- This draft is not deployed. Review it and add the secrets in the dashboards before connecting it to ChatGPT.

## Source

The API catalogue is read at runtime from `https://evolution-go-x7li.onrender.com/swagger/doc.json` and cached in a Worker isolate for five minutes. If the deployed service does not expose that Swagger JSON URL, `evolution_api_catalog` will return a clear error; the public Swagger UI is at `https://evolution-go-x7li.onrender.com/swagger/index.html`.
