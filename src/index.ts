import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const EVOLUTION_BASE = "https://evolution-go-x7li.onrender.com";
const OPENAPI_URL = `${EVOLUTION_BASE}/swagger/doc.json`;
const MAX_SPEC_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 24_000;
const MAX_MESSAGE_LIMIT = 100;

interface Env {
  MCP_ACCESS_TOKEN: string;
  EVOLUTION_INSTANCE_TOKEN: string;
  EVOLUTION_GLOBAL_API_KEY?: string;
  WHATSAPP_READ_URL?: string;
  WHATSAPP_READ_SECRET?: string;
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

async function authorized(request: Request, env: Env): Promise<boolean> {
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.MCP_ACCESS_TOKEN ?? ""}`;
  if (!env.MCP_ACCESS_TOKEN || supplied.length !== expected.length) return false;
  // Compare the provided and expected values through a keyed digest to avoid
  // a content-dependent comparison. Length is checked before hashing.
  const digest = async (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  return equalSecretBytes(new Uint8Array(a), new Uint8Array(b));
}

function equalSecretBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
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
): Promise<unknown> {
  const write = !["GET", "HEAD"].includes(operation.method);
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
    if (new TextEncoder().encode(requestBody).byteLength > 256 * 1024) throw new Error("Request body is too large (maximum 256 KB).");
  }
  const response = await fetch(target, { method: operation.method, headers, body: requestBody });
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

  server.registerTool("evolution_api_catalog", {
    description: "Read Evolution Go's live API catalogue. Use this first to discover the deployed operation IDs, HTTP methods, paths, input parameters, and request body schema before calling an operation. This tool does not change anything.",
    inputSchema: z.object({ filter: z.string().optional().describe("Optional case-insensitive text filter over operation, tag, path, or summary."), include_schemas: z.boolean().default(false).describe("Include parameter and request body schema details when true.") }),
  }, async ({ filter, include_schemas }) => {
    try {
      const operations = listOperations(await getSpec());
      const normalized = (filter ?? "").toLowerCase();
      const matches = operations.filter((op) => !normalized || `${op.operationId} ${op.path} ${op.summary ?? ""} ${(op.tags ?? []).join(" ")}`.toLowerCase().includes(normalized));
      return textResult(matches.map(({ responses: _responses, ...op }) => include_schemas ? op : ({ operationId: op.operationId, method: op.method, path: op.path, tags: op.tags, summary: op.summary })));
    } catch (error) {
      return safeError(error instanceof Error ? error.message : "Could not load Evolution Go API catalogue.");
    }
  });

  server.registerTool("call_evolution_api", {
    description: "Call one documented Evolution Go API operation by the exact operationId from evolution_api_catalog. Only paths in Evolution Go's own live OpenAPI spec are allowed; the host is fixed to the user's Evolution Go server. Use the instance token for normal operations and the global key for admin operations. For every non-GET operation, require the user to clearly approve that specific action before calling, and set confirm_write=true. Do not use for unsolicited/bulk messaging, adding people to groups without their consent, or circumventing WhatsApp limits. Send one operation per call.",
    inputSchema: z.object({
      operation_id: z.string().min(1),
      path_params: z.record(z.string(), z.unknown()).default({}),
      query: z.record(z.string(), z.unknown()).default({}),
      body: z.unknown().optional(),
      confirm_write: z.boolean().default(false).describe("Must be true only after the user explicitly approved this exact write action."),
    }),
  }, async ({ operation_id, path_params, query, body, confirm_write }) => {
    try {
      const operation = listOperations(await getSpec()).find((op) => op.operationId === operation_id);
      if (!operation) return safeError("Unknown operationId. Call evolution_api_catalog and choose an exact listed operation.");
      return textResult(await callEvolution(env, operation, path_params, query, body, confirm_write));
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
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({ name: "Evolution Go WhatsApp MCP", endpoint: "/mcp", authenticated: true });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (!(await authorized(request, env))) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
