import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import {
  AuthorizationError,
  OAuthAuthorizationServer,
  OAuthResourceServer,
  insufficientScope,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

const EVOLUTION_BASE = "https://evolution-go-x7li.onrender.com";
const OPENAPI_URL = `${EVOLUTION_BASE}/swagger/doc.json`;
const MAX_SPEC_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 24_000;
const MAX_MESSAGE_LIMIT = 100;
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const LOGIN_RATE_WINDOW_SECONDS = 900;
const MAX_LOGIN_FAILURES = 5;
const READ_ONLY_POST_PATHS = new Set([
  "/group/info",
  "/group/invitelink",
  "/message/downloadmedia",
  "/message/status",
  "/newsletter/info",
  "/newsletter/link",
  "/newsletter/messages",
  "/user/avatar",
  "/user/check",
  "/user/info",
]);
const MUTATING_GET_PATHS = new Set([
  "/instance/qr",
  "/license/activate",
  "/license/register",
]);

interface Env {
  MCP_LOGIN_PASSWORD: string;
  MCP_SESSION_SECRET: string;
  OAUTH_KV: KVNamespace;
  EVOLUTION_INSTANCE_TOKEN: string;
  EVOLUTION_GLOBAL_API_KEY?: string;
  WHATSAPP_READ_URL?: string;
  WHATSAPP_READ_SECRET?: string;
}

type OAuthEnv = Env;
type OAuthProps = { userId: string; scopes: string[] };
const OAUTH_SCOPES = ["mcp:read", "mcp:write", "offline_access"];
const AUTH_COOKIE = "__Host-evolution-mcp-auth";
const AUTH_SESSION_SECONDS = 600;
const MCP_ISSUER = "https://cloudflare-evolution-mcp.mitchel1234special.workers.dev";
const MCP_RESOURCE = `${MCP_ISSUER}/mcp`;

const authorizationServer = new OAuthAuthorizationServer<OAuthEnv>({
  issuer: MCP_ISSUER,
  resources: [MCP_RESOURCE],
  scopesSupported: OAUTH_SCOPES,
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register",
});

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function safeHtml(body: string, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { headers });
}

function loginPage(returnTo: string, error = ""): Response {
  const safeReturnTo = htmlEscape(returnTo);
  const alert = error ? `<p class="alert" role="alert">${htmlEscape(error)}</p>` : "";
  return safeHtml(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark light"><title>Sign in · Evolution Go</title><style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#edf5f1;background:#0c1110;font-synthesis:none}
    *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at top,#17352b 0,#0c1110 55%)}
    .card{width:min(100%,440px);padding:34px;border:1px solid #29443a;border-radius:22px;background:#111917;box-shadow:0 24px 80px #0008}
    .brand{display:flex;align-items:center;gap:12px;color:#74f0b3;font-size:14px;font-weight:700;letter-spacing:.04em}.mark{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:#143b2b;font-size:20px}
    h1{margin:28px 0 8px;font-size:27px;letter-spacing:-.03em}p{color:#afc0b8;line-height:1.55}.intro{margin:0 0 24px}.alert{padding:12px 14px;border:1px solid #874747;border-radius:12px;background:#381c1c;color:#ffd1d1}
    label{display:block;margin:0 0 8px;color:#dce8e1;font-size:14px;font-weight:600}input{width:100%;padding:13px 14px;border:1px solid #3b5147;border-radius:11px;background:#0b100e;color:#fff;font:inherit;outline:none}input:focus{border-color:#69dca4;box-shadow:0 0 0 3px #69dca433}
    button{width:100%;margin-top:16px;padding:13px 16px;border:0;border-radius:11px;background:#31c77b;color:#082115;font:inherit;font-weight:750;cursor:pointer}button:hover{background:#65dfa0}button:focus-visible{outline:3px solid #fff;outline-offset:3px}
    .note{margin:20px 0 0;padding-top:17px;border-top:1px solid #26362f;font-size:13px}.lock{color:#74f0b3}.foot{margin:18px 0 0;text-align:center;color:#71877b;font-size:12px}
    </style></head><body><main class="card"><div class="brand"><span class="mark" aria-hidden="true">↗</span><span>EVOLUTION GO · PRIVATE MCP</span></div><h1>Sign in to connect</h1><p class="intro">Use your MCP password to continue connecting ChatGPT to your Evolution Go account.</p>${alert}<form method="post" action="/login"><input type="hidden" name="return_to" value="${safeReturnTo}"><label for="password">MCP password</label><input id="password" type="password" name="password" required minlength="32" autocomplete="current-password" autofocus><button type="submit">Continue securely</button></form><p class="note"><span class="lock">🔒 Private sign-in.</span> This is the separate password you created for this MCP, not your Evolution Go, Render, Supabase, or Google password. You’ll review the requested access before it is granted.</p><p class="foot">Your password is checked by your Cloudflare Worker and is not sent to ChatGPT.</p></main></body></html>`);
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = htmlEscape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${htmlEscape(details.clientDomain)}</strong>.`
    : "This client registered itself; its name is not verified.";
  const descriptions: Record<string, string> = {
    "mcp:read": "Read data exposed by your Evolution Go API, such as chats, contacts, groups, and instance status.",
    "mcp:write": "Send messages and make changes supported by the API, including group and instance management. Each change still needs your explicit approval in chat.",
    "offline_access": "Keep the connection working between ChatGPT sessions by refreshing its access token.",
  };
  const requiredScopes = ["mcp:read", "mcp:write"];
  const missingRequiredScopes = requiredScopes.filter((scope) => !details.scope.includes(scope));
  const canApprove = missingRequiredScopes.length === 0;
  const scopes = details.scope.map((scope) => {
    const required = requiredScopes.includes(scope);
    const accessControl = required
      ? `<input type="hidden" name="scope" value="${htmlEscape(scope)}"><span class="badge">Required</span>`
      : `<input type="checkbox" name="scope" value="${htmlEscape(scope)}" checked>`;
    return `<label class="permission">${accessControl}<span><strong>${htmlEscape(scope)}</strong><small>${htmlEscape(descriptions[scope] ?? "Allow the requested capability described by this scope.")}</small></span></label>`;
  }).join("<br>");
  const incomplete = canApprove ? "" : `<p class="warning">This app requested only part of the access needed. To use Evolution Go’s read and write tools, cancel and reconnect with both <strong>mcp:read</strong> and <strong>mcp:write</strong>. Missing: ${missingRequiredScopes.map(htmlEscape).join(", ")}.</p>`;
  const approvalButton = canApprove ? `<button class="allow" name="decision" value="approve">Allow selected access</button>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark light"><title>Review access · Evolution Go</title><style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#edf5f1;background:#0c1110}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at top,#17352b 0,#0c1110 55%)}
    .card{width:min(100%,620px);padding:32px;border:1px solid #29443a;border-radius:22px;background:#111917;box-shadow:0 24px 80px #0008}.brand{color:#74f0b3;font-size:13px;font-weight:750;letter-spacing:.05em}h1{margin:24px 0 10px;font-size:26px;letter-spacing:-.03em}p{color:#afc0b8;line-height:1.55}.client{margin:0 0 22px;padding:14px 16px;border:1px solid #2b3d34;border-radius:12px;background:#0b100e}.client strong{color:#f2faf5}.permission{display:flex;align-items:flex-start;gap:12px;margin:10px 0;padding:14px;border:1px solid #2b3d34;border-radius:12px;background:#0d1411}.permission input{width:18px;height:18px;margin:2px 0 0;accent-color:#31c77b}.permission strong{display:block;color:#e8f4ec}.permission small{display:block;margin-top:5px;color:#aebfb5;font-size:13px;line-height:1.45}.badge{margin-left:auto;padding:4px 8px;border-radius:999px;background:#18392a;color:#91e9b7;font-size:11px;font-weight:700}.warning{padding:13px 15px;border-left:3px solid #e2a43a;background:#2a2419;color:#e9d7b5;font-size:13px}.actions{display:flex;gap:12px;margin-top:22px}.actions button{flex:1;min-height:46px;border:0;border-radius:11px;font:inherit;font-weight:750;cursor:pointer}.allow{background:#31c77b;color:#082115}.deny{background:#26342d;color:#e9f1ec}.actions button:focus-visible{outline:3px solid #fff;outline-offset:3px}.foot{font-size:12px;color:#71877b}
    </style></head><body><main class="card"><div class="brand">EVOLUTION GO · PERMISSION REVIEW</div><h1>Review this connection</h1><p>Choose what <strong>${name}</strong> can do with your Evolution Go account.</p><div class="client">${origin}<br>Access will be sent to <strong>${htmlEscape(details.redirectHost)}</strong>.</div>${details.redirectIsLoopback ? `<p class="warning">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>` : ""}${incomplete}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${htmlEscape(handle)}">${scopes}<div class="actions">${approvalButton}<button class="deny" name="decision" value="deny">Cancel</button></div></form><form method="post" action="/logout"><button class="deny" type="submit">Sign out from this browser</button></form><p class="foot">The password is never shared with this client. State-changing calls still require your specific approval in chat.</p></main></body></html>`;
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(left)),
    crypto.subtle.digest("SHA-256", enc.encode(right)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function loginRateKey(request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown-client";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address)));
  return `evolution-mcp:login-rate:${bytesToBase64Url(digest)}`;
}

async function signSession(expiry: number, secret: string): Promise<string> {
  const payload = String(expiry);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${bytesToBase64Url(signature)}`;
}

async function validSession(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${AUTH_COOKIE}=`));
  const value = cookie?.slice(AUTH_COOKIE.length + 1) ?? "";
  const [expiryText, signature, extra] = value.split(".");
  if (!expiryText || !signature || extra !== undefined) return false;
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000) || expiry > Math.floor(Date.now() / 1000) + AUTH_SESSION_SECONDS + 30) return false;
  const expected = await signSession(expiry, env.MCP_SESSION_SECRET ?? "");
  return await equalSecret(value, expected);
}

function sameOrigin(request: Request, env: Env): boolean {
  return request.headers.get("Origin") === MCP_ISSUER;
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" || !sameOrigin(request, env)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const returnTo = String(form.get("return_to") ?? "");
  let returnUrl: URL;
  try { returnUrl = new URL(returnTo, MCP_ISSUER); } catch { return new Response("Invalid sign-in request", { status: 400 }); }
  if (returnUrl.origin !== MCP_ISSUER || returnUrl.pathname !== "/authorize" || !returnUrl.search) return new Response("Invalid sign-in request", { status: 400 });
  const rateKey = await loginRateKey(request);
  const attempts = await env.OAUTH_KV.get<{ count: number }>(rateKey, "json");
  if ((attempts?.count ?? 0) >= MAX_LOGIN_FAILURES) {
    const response = loginPage(returnTo, "Too many attempts. Wait 15 minutes, then try again.");
    const headers = new Headers(response.headers);
    headers.set("Retry-After", String(LOGIN_RATE_WINDOW_SECONDS));
    return new Response(response.body, { status: 429, headers });
  }
  if (!env.MCP_LOGIN_PASSWORD || !env.MCP_SESSION_SECRET || password.length < 32 || !(await equalSecret(password, env.MCP_LOGIN_PASSWORD))) {
    await env.OAUTH_KV.put(rateKey, JSON.stringify({ count: (attempts?.count ?? 0) + 1 }), { expirationTtl: LOGIN_RATE_WINDOW_SECONDS });
    return loginPage(returnTo, "That password didn’t match, or OAuth sign-in is not fully configured yet. Check the MCP secrets and try again.");
  }
  await env.OAUTH_KV.delete(rateKey);
  const expiry = Math.floor(Date.now() / 1000) + AUTH_SESSION_SECONDS;
  const value = await signSession(expiry, env.MCP_SESSION_SECRET);
  const headers = new Headers({ "Location": returnUrl.toString(), "Set-Cookie": `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_SESSION_SECONDS}` });
  return new Response(null, { status: 303, headers });
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  if (request.method === "POST") {
    if (!sameOrigin(request, env) || !(await validSession(request, env))) return new Response("Sign in again to authorize this connection.", { status: 401 });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") === "deny") {
      try {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      } catch {
        return new Response("This authorization request expired. Start again from ChatGPT.", { status: 400 });
      }
    }
    try {
      const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "owner",
        metadata: { name: "Evolution Go owner" },
        scope: approved.request.scope,
        props: { userId: "owner", scopes: approved.request.scope },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch {
      return new Response("This authorization request expired or is invalid. Start again from ChatGPT.", { status: 400 });
    }
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    if (!(await validSession(request, env))) return loginPage(new URL(request.url).pathname + new URL(request.url).search);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return safeHtml(consentPage(details, consent.handle), consent.headers);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
      return new Response(error.description, { status: 400 });
    }
    return new Response("Could not start authorization. Please try again.", { status: 500 });
  }
}

async function handleLogout(request: Request): Promise<Response> {
  if (request.method !== "POST" || request.headers.get("Origin") !== MCP_ISSUER) return new Response("Forbidden", { status: 403 });
  return new Response("You are signed out. You can close this page.", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}

type JsonObject = Record<string, unknown>;
type ApiOperation = {
  method: string;
  path: string;
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: unknown;
};
type ApiSpec = { paths?: Record<string, Record<string, any>>; components?: JsonObject; definitions?: JsonObject };

let cachedSpec: { expiresAt: number; spec: ApiSpec } | undefined;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function textResult(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: serialized.slice(0, MAX_RESPONSE_CHARS) }] };
}

function safeError(message: string) {
  return textResult({ error: message });
}

async function getSpec(): Promise<ApiSpec> {
  if (cachedSpec && cachedSpec.expiresAt > Date.now()) return cachedSpec.spec;
  const response = await fetch(OPENAPI_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Evolution Go API description returned HTTP ${response.status}.`);
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SPEC_BYTES) throw new Error("Evolution Go API description is unexpectedly large.");
  const spec = JSON.parse(raw) as ApiSpec;
  if (!spec.paths || typeof spec.paths !== "object") throw new Error("Evolution Go API description has no paths.");
  cachedSpec = { spec, expiresAt: Date.now() + 5 * 60 * 1000 };
  return spec;
}

function listOperations(spec: ApiSpec): ApiOperation[] {
  const operations: ApiOperation[] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, raw] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method.toLowerCase())) continue;
      const operation = object(raw);
      const operationId = typeof operation.operationId === "string"
        ? operation.operationId
        : `${method}_${path}`.replace(/[^a-zA-Z0-9_]+/g, "_");
      operations.push({ method: method.toUpperCase(), path, operationId,
        summary: typeof operation.summary === "string" ? operation.summary : undefined,
        description: typeof operation.description === "string" ? operation.description : undefined,
        tags: Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : [],
        parameters: Array.isArray(operation.parameters) ? resolveRefs(spec, operation.parameters) as unknown[] : [],
        requestBody: resolveRefs(spec, operation.requestBody),
        responses: operation.responses,
      });
    }
  }
  return operations;
}

function resolveRefs(spec: ApiSpec, value: unknown, seen = new Set<string>(), depth = 0): unknown {
  if (depth > 6) return "[schema reference depth limit]";
  if (Array.isArray(value)) return value.map((item) => resolveRefs(spec, item, seen, depth + 1));
  if (!value || typeof value !== "object") return value;
  const record = value as JsonObject;
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
    const ref = record.$ref;
    if (seen.has(ref)) return { $ref: ref, note: "recursive reference shortened" };
    const segments = ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    let target: unknown = spec;
    for (const segment of segments) target = object(target)[segment];
    if (target === undefined) return { $ref: ref, note: "reference not found in API description" };
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    return resolveRefs(spec, target, nextSeen, depth + 1);
  }
  const expanded: JsonObject = {};
  for (const [key, nested] of Object.entries(record)) expanded[key] = resolveRefs(spec, nested, seen, depth + 1);
  return expanded;
}

function isAdminOperation(path: string): boolean {
  return path === "/instance/create" || path === "/instance/all" ||
    path === "/instance/delete" || path.startsWith("/instance/delete/") ||
    path === "/instance/info" || path.startsWith("/instance/info/") ||
    path.startsWith("/license/");
}

function requiresWriteApproval(operation: ApiOperation): boolean {
  if (READ_ONLY_POST_PATHS.has(operation.path)) return false;
  if (MUTATING_GET_PATHS.has(operation.path)) return true;
  return !["GET", "HEAD"].includes(operation.method);
}

function fillPath(path: string, pathParams: JsonObject): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === null || String(value).length === 0) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

function truncate(value: unknown): unknown {
  const raw = JSON.stringify(value);
  if (raw.length <= MAX_RESPONSE_CHARS) return value;
  return { truncated: true, preview: raw.slice(0, MAX_RESPONSE_CHARS), note: "Response was shortened to fit the MCP result limit." };
}

async function callEvolution(
  env: Env,
  operation: ApiOperation,
  pathParams: JsonObject,
  query: JsonObject,
  body: unknown,
  confirmWrite: boolean,
  writeScope: boolean,
): Promise<unknown> {
  const write = requiresWriteApproval(operation);
  if (write && !writeScope) throw new Error("This OAuth connection does not have mcp:write permission. Reconnect and approve the write scope first.");
  if (write && confirmWrite !== true) {
    throw new Error("This operation changes data. Call again only after the user has explicitly approved this exact action, with confirm_write=true.");
  }
  const path = fillPath(operation.path, pathParams);
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("The API description contains an unsafe path.");
  const target = new URL(path, EVOLUTION_BASE);
  if (target.origin !== new URL(EVOLUTION_BASE).origin) throw new Error("Refusing to send an API key outside the configured Evolution Go server.");
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") target.searchParams.set(key, JSON.stringify(value));
    else target.searchParams.set(key, String(value));
  }

  const apiKey = isAdminOperation(operation.path)
    ? env.EVOLUTION_GLOBAL_API_KEY
    : env.EVOLUTION_INSTANCE_TOKEN;
  if (!apiKey) throw new Error(isAdminOperation(operation.path)
    ? "EVOLUTION_GLOBAL_API_KEY is not configured in Cloudflare."
    : "EVOLUTION_INSTANCE_TOKEN is not configured in Cloudflare.");

  const headers = new Headers({ Accept: "application/json", apikey: apiKey });
  let requestBody: string | undefined;
  if (body !== undefined && body !== null && !["GET", "HEAD"].includes(operation.method)) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(body);
    if (new TextEncoder().encode(requestBody).byteLength > MAX_REQUEST_BODY_BYTES) throw new Error("Request body is too large (maximum 20 MB). Use a smaller media file or a supported media URL.");
  }
  let response: Response;
  try {
    response = await fetch(target, {
      method: operation.method,
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`Evolution Go API request timed out after 30 seconds (${operation.method} ${operation.path}). Check the Evolution Go service logs and this API route.`);
    }
    throw error;
  }
  const raw = await response.text();
  let responseBody: unknown = raw;
  try { responseBody = raw ? JSON.parse(raw) : null; } catch { /* keep plain-text response */ }
  return {
    operation: operation.operationId,
    method: operation.method,
    path: operation.path,
    status: response.status,
    ok: response.ok,
    result: truncate(responseBody),
  };
}

async function readSavedMessages(env: Env, args: { instance?: string; since?: string; limit: number }) {
  if (!env.WHATSAPP_READ_URL || !env.WHATSAPP_READ_SECRET) {
    return safeError("Saved-message reading is not connected yet. Deploy the whatsapp-mcp-read Supabase function and add WHATSAPP_READ_URL and WHATSAPP_READ_SECRET in Cloudflare.");
  }
  const response = await fetch(env.WHATSAPP_READ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mcp-read-secret": env.WHATSAPP_READ_SECRET },
    body: JSON.stringify({ instance: args.instance, since: args.since, limit: Math.min(Math.max(args.limit, 1), MAX_MESSAGE_LIMIT) }),
  });
  const raw = await response.text();
  let result: unknown = raw;
  try { result = raw ? JSON.parse(raw) : null; } catch { /* leave plain text */ }
  if (!response.ok) return safeError(`Message history read failed with HTTP ${response.status}: ${JSON.stringify(result).slice(0, 800)}`);
  return textResult(truncate(result));
}

function createServer(env: Env) {
  const server = new McpServer({ name: "Evolution Go WhatsApp", version: "1.0.0" });
  const auth = getMcpAuthContext()?.props as OAuthProps | undefined;
  const writeScope = auth?.scopes?.includes("mcp:write") === true;

  server.registerTool("evolution_connection_status", {
    description: "Check whether this Worker can reach the live Evolution Go API and list the documented feature groups. This is read-only and never sends a WhatsApp message or changes account data.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      const spec = await getSpec();
      const operations = listOperations(spec);
      const categories = [...new Set(operations.flatMap((op) => op.tags ?? []))].sort();
      const apiKey = env.EVOLUTION_INSTANCE_TOKEN;
      if (!apiKey) return textResult({ ready: false, problem: "The Evolution instance API token is not configured as a Cloudflare Secret.", documented_operations: operations.length, categories, write_access: writeScope });
      const response = await fetch(new URL("/instance/status", EVOLUTION_BASE), { headers: { Accept: "application/json", apikey: apiKey } });
      const raw = await response.text();
      let result: unknown = raw;
      try { result = raw ? JSON.parse(raw) : null; } catch { /* preserve text response */ }
      return textResult({ ready: response.ok, evolution_api: { status: response.status, result: truncate(result) }, documented_operations: operations.length, categories, write_access: writeScope, global_admin_access_configured: Boolean(env.EVOLUTION_GLOBAL_API_KEY), saved_message_reader_configured: Boolean(env.WHATSAPP_READ_URL && env.WHATSAPP_READ_SECRET) });
    } catch (error) {
      return safeError(error instanceof Error ? error.message : "Could not check the Evolution Go connection.");
    }
  });

  server.registerTool("evolution_api_catalog", {
    description: "Read Evolution Go's live API catalogue. Use this first to discover the deployed operation IDs, HTTP methods, paths, input parameters, and request body schema before calling an operation. This tool does not change anything.",
    inputSchema: z.object({ filter: z.string().optional().describe("Optional case-insensitive text filter over operation, tag, path, or summary."), include_schemas: z.boolean().default(false).describe("Include parameter and request body schema details when true.") }),
  }, async ({ filter, include_schemas }) => {
    try {
      const operations = listOperations(await getSpec());
      const normalized = (filter ?? "").toLowerCase();
      const matches = operations.filter((op) => !normalized || `${op.operationId} ${op.path} ${op.summary ?? ""} ${(op.tags ?? []).join(" ")}`.toLowerCase().includes(normalized));
      return textResult(matches.map(({ responses: _responses, ...op }) => include_schemas
        ? { ...op, requires_write_approval: requiresWriteApproval(op) }
        : { operationId: op.operationId, method: op.method, path: op.path, tags: op.tags, summary: op.summary, requires_write_approval: requiresWriteApproval(op) }));
    } catch (error) {
      return safeError(error instanceof Error ? error.message : "Could not load Evolution Go API catalogue.");
    }
  });

  server.registerTool("call_evolution_api", {
    description: "Call any documented Evolution Go API operation by the exact operationId from evolution_api_catalog. This covers sending messages, chats, contacts, groups, communities, instances, labels, newsletters, polls, and other live Swagger operations. The host is fixed to the user's Evolution Go server. Use only when the user requests the specific action. Before a send or state-changing operation (including group or instance changes, license changes, deletes, reactions, read receipts, and presence updates), describe the exact action and get the user's approval, then set confirm_write=true. Read-only API calls, including POST routes documented as Get/Download, do not need write approval. Do not send unsolicited/bulk messages, add people to groups without their consent, or bypass WhatsApp limits. Make one API call at a time.",
    inputSchema: z.object({
      operation_id: z.string().min(1),
      path_params: z.record(z.string(), z.unknown()).default({}),
      query: z.record(z.string(), z.unknown()).default({}),
      body: z.unknown().optional(),
      confirm_write: z.boolean().default(false).describe("Set true only after the user explicitly approved the exact state-changing action; leave false for reads."),
    }),
  }, async ({ operation_id, path_params, query, body, confirm_write }) => {
    try {
      const operation = listOperations(await getSpec()).find((op) => op.operationId === operation_id);
      if (!operation) return safeError("Unknown operationId. Call evolution_api_catalog and choose an exact listed operation.");
      return textResult(await callEvolution(env, operation, path_params, query, body, confirm_write, writeScope));
    } catch (error) {
      return safeError(error instanceof Error ? error.message : "Evolution Go request failed.");
    }
  });

  server.registerTool("whatsapp_saved_incoming_messages", {
    description: "Read messages saved by the configured Supabase webhook. It returns incoming message rows only; it cannot retrieve WhatsApp messages from before the webhook was connected or while Evolution Go was offline.",
    inputSchema: z.object({ instance: z.string().optional(), since: z.string().optional().describe("ISO 8601 date/time lower bound, for example 2026-10-27T00:00:00Z."), limit: z.number().int().min(1).max(MAX_MESSAGE_LIMIT).default(50) }),
  }, async (args) => readSavedMessages(env, args));

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      let apiAvailable = false;
      try { await getSpec(); apiAvailable = true; } catch { /* readiness is reported below */ }
      const ready = Boolean(env.OAUTH_KV && env.MCP_LOGIN_PASSWORD && env.MCP_SESSION_SECRET &&
        env.EVOLUTION_INSTANCE_TOKEN && env.EVOLUTION_GLOBAL_API_KEY && apiAvailable);
      return Response.json({ status: ready ? "ready" : "needs_configuration", api_catalog_available: apiAvailable }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({ name: "Evolution Go WhatsApp MCP", endpoint: "/mcp", authentication: "OAuth 2.1" });
    }
    if (url.pathname === "/login") return handleLogin(request, env);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/logout") return handleLogout(request);
    if (url.pathname === "/mcp") return resourceServer.fetch(request, env, ctx);
    return authorizationServer.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

const resourceServer = new OAuthResourceServer<Env, OAuthProps>({
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ISSUER],
  },
  // Require full read/write authorization at connection time. Individual
  // state-changing API operations also require explicit per-action approval.
  requiredScopes: ["mcp:read", "mcp:write"],
  validateToken: (env) => (resource, token) => authorizationServer.validateToken(resource, token, env),
  handler: {
    fetch(request, env, ctx) {
      if (!ctx.auth.scope.includes("mcp:read")) return insufficientScope(ctx.auth, ["mcp:read"]);
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    },
  },
});
