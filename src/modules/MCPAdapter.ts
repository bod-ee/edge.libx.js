import { RouterType, IRequest } from 'itty-router';
import { MCPAuth, MCPAuthOptions } from './MCPAuth';

// ── MCP progress (notifications/progress) ────────────────────────────────────
// A tool handler can stream progress to the client mid-call via reportMcpProgress().
// The active channel is carried in an AsyncLocalStorage so handlers stay plain
// (request → response) — no signature changes. AsyncLocalStorage is loaded
// defensively: on edge runtimes that lack node:async_hooks, progress degrades to
// a no-op (tools still work, just without live updates).
type ProgressSink = (notification: any) => void;
interface ProgressContext {
	token: string | number;
	send: ProgressSink;
	counter: { n: number };
}
let progressStore: { getStore(): ProgressContext | undefined; run<T>(ctx: ProgressContext, fn: () => T): T } | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { AsyncLocalStorage } = require('node:async_hooks');
	progressStore = new AsyncLocalStorage();
} catch {
	/* edge runtime without async_hooks — reportMcpProgress becomes a no-op */
}

export interface McpProgressOptions {
	/** Explicit progress value. Omit to auto-increment. MUST be monotonic per token (MCP spec). */
	progress?: number;
	/** Optional known total, for a determinate progress bar. */
	total?: number;
}

export type McpProgressReporter = (message: string, opts?: McpProgressOptions) => void;

function emitProgress(ctx: ProgressContext, message: string, opts?: McpProgressOptions): void {
	const progress = opts?.progress ?? (ctx.counter.n += 1);
	ctx.send({
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: { progressToken: ctx.token, progress, ...(opts?.total != null ? { total: opts.total } : {}), message },
	});
}

/**
 * Report progress for the in-flight MCP `tools/call`. No-op when called outside a
 * progress-enabled call (no client progressToken, or unsupported runtime), so it
 * is always safe to call from a tool handler. NOTE: must be called within the
 * handler's own async context — if you emit from a detached callback (child-process
 * stream events, timers, listeners), use captureMcpProgress() instead, which binds
 * the channel synchronously and keeps working across context boundaries.
 */
export function reportMcpProgress(message: string, opts?: McpProgressOptions): void {
	const ctx = progressStore?.getStore();
	if (ctx) emitProgress(ctx, message, opts);
}

/**
 * Capture the active progress channel synchronously and return a reporter bound to
 * it. The returned function keeps working even when called outside the async context
 * (e.g. from stream 'data' events or timers), where reportMcpProgress would no-op.
 * Call this at handler entry; returns a no-op reporter when no progress is requested.
 */
export function captureMcpProgress(): McpProgressReporter {
	const ctx = progressStore?.getStore();
	if (!ctx) return () => {};
	return (message, opts) => emitProgress(ctx, message, opts);
}

export interface MCPOptions {
	name?: string;
	version?: string;
	/** System-level instructions injected into the agent's context on connect (no user action needed). */
	instructions?: string;
	/** OAuth 2.1 config. If provided, MCP endpoint requires OAuth tokens. */
	auth?: Partial<MCPAuthOptions>;
	/** Extra params injected into every tool's input schema. */
	globalParams?: Record<string, { type?: string; description?: string }>;
	/** Wraps every callTool invocation — use for auth context, logging, etc. */
	onToolCall?: (name: string, args: Record<string, any>, next: () => Promise<any>) => Promise<any>;
}

interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

interface ToolMeta {
	description?: string;
	params?: Record<string, { description?: string; type?: string; required?: boolean }>;
	annotations?: ToolAnnotations;
}

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, any>;
		required: string[];
	};
	annotations?: ToolAnnotations;
}

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number;
	method: string;
	params?: any;
}

export class MCPAdapter {
	private router: RouterType<any, any[], any>;
	private base: string;
	private fetchHandler: (request: IRequest, ctx?: any) => Promise<Response>;
	private serverName: string;
	private serverVersion: string;
	private instructions?: string;
	private mcpMeta: Map<string, ToolMeta>;
	private globalParams?: Record<string, { type?: string; description?: string }>;
	private onToolCall?: MCPOptions['onToolCall'];
	public auth?: MCPAuth;
	/** Cached tool descriptors, invalidated when the route count changes. */
	private toolsCache?: ToolDefinition[];
	private toolsCacheRouteCount = -1;

	constructor(
		router: RouterType<any, any[], any>,
		base: string,
		fetchHandler: (request: IRequest, ctx?: any) => Promise<Response>,
		mcpMeta: Map<string, ToolMeta>,
		options?: MCPOptions,
	) {
		this.router = router;
		this.base = base;
		this.fetchHandler = fetchHandler;
		this.mcpMeta = mcpMeta;
		this.serverName = options?.name ?? 'MCP Server';
		this.serverVersion = options?.version ?? '1.0.0';
		this.instructions = options?.instructions;
		this.globalParams = options?.globalParams;
		this.onToolCall = options?.onToolCall;
		if (options?.auth) {
			this.auth = new MCPAuth(options.auth);
		}
	}

	public toolNameFromRoute(method: string, path: string): string {
		let name = path;
		// Strip base path
		if (this.base && name.startsWith(this.base)) {
			name = name.slice(this.base.length);
		}
		// Remove leading slash
		name = name.replace(/^\//, '');
		// Replace :param with "by_param"
		name = name.replace(/:(\w+)/g, 'by_$1');
		// Replace slashes with underscores
		name = name.replace(/\//g, '_');
		// Prepend method
		name = `${method.toLowerCase()}_${name}`;
		// Clean up double underscores
		name = name.replace(/_+/g, '_').replace(/_$/, '');
		return name;
	}

	public inferQueryParams(handlers: Function[]): string[] {
		const params = new Set<string>();
		for (const handler of handlers) {
			try {
				const src = handler.toString();
				// Match req.query.paramName, request.query.paramName, query.paramName
				const dotPattern = /(?:req(?:uest)?\.)?query\.(\w+)/g;
				let match: RegExpExecArray | null;
				while ((match = dotPattern.exec(src)) !== null) {
					params.add(match[1]);
				}
				// Match req.query['paramName'] or req.query["paramName"]
				const bracketPattern = /(?:req(?:uest)?\.)?query\[['"](\w+)['"]\]/g;
				while ((match = bracketPattern.exec(src)) !== null) {
					params.add(match[1]);
				}
				// Match destructured: const { a, b, c } = req.query  or  = request.query
				const destructPattern = /(?:const|let|var)\s*\{\s*([^}]+)\}\s*=\s*(?:req(?:uest)?\.)?query/g;
				while ((match = destructPattern.exec(src)) !== null) {
					for (const name of match[1].split(',')) {
						const clean = name.trim().split(/[\s:]/)[0];
						if (clean && /^\w+$/.test(clean)) params.add(clean);
					}
				}
			} catch {
				// handler.toString() may fail for native code
			}
		}
		return Array.from(params);
	}

	public introspectRoutes(): ToolDefinition[] {
		// Descriptors are derived purely from routes/meta/globalParams. Routes are
		// effectively frozen once asMCP() is wired, so build once and serve from
		// cache — this keeps `tools/list` (212 tools here) to a memory read instead
		// of re-running handler.toString() + regex inference on every request. The
		// cache is keyed on route count so routes added later are still reflected.
		const routes: any[] = (this.router as any).routes ?? [];
		if (this.toolsCache && this.toolsCacheRouteCount === routes.length) return this.toolsCache;
		const tools: ToolDefinition[] = [];

		for (const route of routes) {
			// itty-router v5 stores routes as [method, regex, handlers[], path]
			const [method, , handlers, originalPath] = route;

			// Skip wildcard catch-alls and OPTIONS
			if (!originalPath || originalPath === '*' || originalPath.endsWith('/*')) continue;
			if (method === 'OPTIONS' || method === 'ALL') continue;

			const toolName = this.toolNameFromRoute(method, originalPath);
			const metaKey = `${method}:${originalPath}`;
			const meta = this.mcpMeta.get(metaKey);

			const properties: Record<string, any> = {};
			const required: string[] = [];

			// Extract path params
			const paramPattern = /:(\w+)/g;
			let match: RegExpExecArray | null;
			while ((match = paramPattern.exec(originalPath)) !== null) {
				const paramName = match[1];
				properties[paramName] = {
					type: meta?.params?.[paramName]?.type ?? 'string',
					...(meta?.params?.[paramName]?.description && { description: meta.params[paramName].description }),
				};
				required.push(paramName);
			}

			// Infer query params for all methods
			const queryParams = this.inferQueryParams(handlers);
			const querySet = new Set(queryParams);

			// POST/PUT/PATCH get a body property — typed from declared params so the schema is
			// self-describing (declared params that aren't path/query params become body fields).
			if (['POST', 'PUT', 'PATCH'].includes(method)) {
				const bodyProps: Record<string, any> = {};
				const bodyRequired: string[] = [];
				for (const [pname, pdef] of Object.entries(meta?.params ?? {})) {
					if (pname === 'body' || properties[pname] || querySet.has(pname)) continue; // skip path/query/body-meta
					bodyProps[pname] = { type: (pdef as any)?.type ?? 'string', ...((pdef as any)?.description && { description: (pdef as any).description }) };
					if ((pdef as any)?.required) bodyRequired.push(pname);
				}
				properties['body'] = {
					type: 'object',
					description: meta?.params?.['body']?.description ?? 'Request body',
					...(Object.keys(bodyProps).length > 0 && { properties: bodyProps }),
					...(bodyRequired.length > 0 && { required: bodyRequired }),
				};
			}

			// The DECLARED params are the tool's contract — honour them for GET/DELETE instead of
			// only letting them enrich a name that inference happened to find. inferQueryParams()
			// scans the handler's *transpiled source* for `query.X`, which is best-effort at most:
			// it is defeated by reading params through a helper (`qp(req, 'path')`), by
			// `req.query?.x` (the optional chain breaks the literal), by a single-use
			// `const query = req.query` (bundlers inline it away), by statement order (Bun merges
			// consecutive consts into one comma-list), and by any minifier. Servers really did ship
			// `properties: {}` for a REQUIRED param — an agent cannot learn it exists, so the tool
			// is uncallable. Inference stays as a SUPPLEMENT so servers that never declared their
			// params keep working unchanged.
			// POST/PUT/PATCH are excluded: there, declared params become body fields (above).
			const declaredQuery = ['POST', 'PUT', 'PATCH'].includes(method)
				? []
				: Object.keys(meta?.params ?? {}).filter((n) => n !== 'body' && !properties[n]);

			for (const qp of new Set([...declaredQuery, ...queryParams])) {
				if (!properties[qp]) {
					properties[qp] = {
						type: meta?.params?.[qp]?.type ?? 'string',
						...(meta?.params?.[qp]?.description && { description: meta.params[qp].description }),
					};
				}
				if (meta?.params?.[qp]?.required && !required.includes(qp)) {
					required.push(qp);
				}
			}

			if (this.globalParams) {
				for (const [key, schema] of Object.entries(this.globalParams)) {
					if (!properties[key]) {
						properties[key] = { type: schema.type ?? 'string', ...(schema.description && { description: schema.description }) };
					}
				}
			}

			const description = meta?.description ?? `${method} ${originalPath}`;

			tools.push({
				name: toolName,
				description,
				inputSchema: {
					type: 'object',
					properties,
					required,
				},
				...(meta?.annotations && { annotations: meta.annotations }),
			});
		}

		this.toolsCache = tools;
		this.toolsCacheRouteCount = routes.length;
		return tools;
	}

	private findRoute(toolName: string): { method: string; path: string; handlers: Function[] } | null {
		const routes: any[] = (this.router as any).routes ?? [];
		for (const route of routes) {
			const [method, , handlers, originalPath] = route;
			if (!originalPath || originalPath === '*' || originalPath.endsWith('/*')) continue;
			if (method === 'OPTIONS' || method === 'ALL') continue;
			if (this.toolNameFromRoute(method, originalPath) === toolName) {
				return { method, path: originalPath, handlers };
			}
		}
		return null;
	}

	public async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
		if (this.onToolCall) {
			return this.onToolCall(name, args, () => this._callTool(name, args));
		}
		return this._callTool(name, args);
	}

	private async _callTool(name: string, args: Record<string, any> = {}): Promise<any> {
		const route = this.findRoute(name);
		if (!route) {
			return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
		}

		const { method, path } = route;

		// For GET/DELETE, the MCP client wraps params in args.body but the HTTP
		// handler reads them from req.query. Flatten body into top-level args.
		if (!['POST', 'PUT', 'PATCH'].includes(method) && args.body && typeof args.body === 'object') {
			const { body, ...rest } = args;
			args = { ...rest, ...body };
		}

		// Build URL with path params substituted
		let url = path;
		const pathParamPattern = /:(\w+)/g;
		let match: RegExpExecArray | null;
		while ((match = pathParamPattern.exec(path)) !== null) {
			const paramName = match[1];
			if (args[paramName] != null) {
				url = url.replace(`:${paramName}`, encodeURIComponent(String(args[paramName])));
			}
		}

		// Build query string for non-path, non-body params
		const pathParams = new Set<string>();
		const ppPattern = /:(\w+)/g;
		let m: RegExpExecArray | null;
		while ((m = ppPattern.exec(path)) !== null) pathParams.add(m[1]);

		const queryParams: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			if (key === 'body' || pathParams.has(key)) continue;
			queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		}
		if (queryParams.length > 0) {
			url += '?' + queryParams.join('&');
		}

		const fullUrl = `http://localhost${url}`;
		const headers: Record<string, string> = {};
		if (this.auth?.options.secret) headers['Authorization'] = `Bearer ${this.auth.options.secret}`;
		if (['POST', 'PUT', 'PATCH'].includes(method)) headers['Content-Type'] = 'application/json';
		const requestInit: RequestInit = { method, headers };
		if (['POST', 'PUT', 'PATCH'].includes(method)) {
			requestInit.body = JSON.stringify(args.body || {});
		}

		const request = new Request(fullUrl, requestInit);

		try {
			const response = await this.fetchHandler(request as any);
			const text = await response.text();
			let content: any;
			try {
				content = JSON.parse(text);
			} catch {
				content = text;
			}
			const isError = !response.ok;

			// Detect dataUrl fields and return proper MCP image content blocks
			if (!isError && content && typeof content === 'object' && typeof content.dataUrl === 'string' && content.dataUrl.startsWith('data:')) {
				const match = content.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
				if (match) {
					const blocks: any[] = [];
					const rest = Object.fromEntries(Object.entries(content).filter(([k]) => k !== 'dataUrl'));
					if (Object.keys(rest).length > 0) blocks.push({ type: 'text', text: JSON.stringify(rest) });
					blocks.push({ type: 'image', data: match[2], mimeType: match[1] });
					return { content: blocks };
				}
			}

			return {
				...(isError && { isError: true }),
				content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }],
			};
		} catch (err: any) {
			return {
				isError: true,
				content: [{ type: 'text', text: err?.message ?? String(err) }],
			};
		}
	}

	public async handleJsonRpc(message: JsonRpcRequest, sendNotification?: ProgressSink): Promise<any> {
		const { method, id, params } = message;

		switch (method) {
			case 'initialize':
				return {
					jsonrpc: '2.0',
					id,
					result: {
						protocolVersion: '2024-11-05',
						capabilities: { tools: { listChanged: true } },
						serverInfo: { name: this.serverName, version: this.serverVersion },
						...(this.instructions && { instructions: this.instructions }),
					},
				};

			case 'notifications/initialized':
				// No response needed for notifications
				return null;

			case 'tools/list':
				return {
					jsonrpc: '2.0',
					id,
					result: { tools: this.introspectRoutes() },
				};

			case 'tools/call': {
				const token = params?._meta?.progressToken;
				const invoke = () => this.callTool(params?.name, params?.arguments ?? {});
				const result =
					token != null && sendNotification && progressStore
						? await progressStore.run({ token, send: sendNotification, counter: { n: 0 } }, invoke)
						: await invoke();
				return {
					jsonrpc: '2.0',
					id,
					result,
				};
			}

			case 'ping':
				// MCP spec: a `ping` MUST be answered with an empty result. Clients (e.g. Claude
				// Code) ping idle stdio servers as a liveness check; returning the -32601 default
				// instead makes the client treat the transport as dead and disconnect.
				return { jsonrpc: '2.0', id, result: {} };

			default:
				return {
					jsonrpc: '2.0',
					id,
					error: { code: -32601, message: `Method not found: ${method}` },
				};
		}
	}

	public httpHandler = async (request: Request): Promise<Response> => {
		// Auth validation (if configured): accept raw API key OR OAuth JWT
		if (this.auth) {
			const authHeader = request.headers.get('Authorization');
			const isRawKey = authHeader === `Bearer ${this.auth.options.secret}`;
			if (!isRawKey) {
				const valid = await this.auth.validateToken(request);
				if (!valid) return this.auth.unauthorizedResponse();
			}
		}

		if (request.method === 'GET') {
			// SSE endpoint for server-sent events (Streamable HTTP)
			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode(`event: endpoint\ndata: /mcp\n\n`));
					// Keep connection open - client will close
				},
			});
			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
				},
			});
		}

		// POST: JSON-RPC request
		try {
			const body = await request.json() as JsonRpcRequest;

			// Streamable HTTP: when the client passes a progressToken and accepts an
			// event-stream, respond with SSE so notifications/progress can be emitted
			// mid-call (followed by the final JSON-RPC response), then close.
			const token = body?.method === 'tools/call' ? (body.params as any)?._meta?.progressToken : undefined;
			const acceptsSse = (request.headers.get('accept') || '').includes('text/event-stream');
			if (token != null && acceptsSse && progressStore) {
				const handle = this.handleJsonRpc.bind(this);
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						const send: ProgressSink = (n) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(n)}\n\n`));
						try {
							const result = await handle(body, send);
							if (result !== null) send(result);
						} catch (err: any) {
							send({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: err?.message ?? String(err) } });
						}
						controller.close();
					},
				});
				return new Response(stream, {
					headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
				});
			}

			const result = await this.handleJsonRpc(body);
			if (result === null) {
				return new Response(null, { status: 204 });
			}
			return new Response(JSON.stringify(result), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (err: any) {
			return new Response(JSON.stringify({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32700, message: 'Parse error' },
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	};

	public async serveStdio(options?: { idleTimeoutMs?: number }): Promise<void> {
		const proc = (globalThis as any).process;
		const stdin = proc.stdin;
		const stdout = proc.stdout;
		const stderr = proc.stderr;
		// Precedence: explicit option → MCP_STDIO_IDLE_MS env → 30min default. Set the env (or option)
		// to 0 to disable the self-exit entirely (server lives for the whole client session). The env
		// knob lets any edge.libx MCP be tuned at launch without a code change.
		const envIdle = Number(proc.env?.MCP_STDIO_IDLE_MS);
		const idleMs = options?.idleTimeoutMs ?? (Number.isFinite(envIdle) ? envIdle : 30 * 60_000);

		stdin.setEncoding('utf8');

		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const resetIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			if (idleMs > 0) {
				idleTimer = setTimeout(() => {
					stderr.write(`[MCP] Idle timeout (${idleMs / 1000}s) — exiting\n`);
					proc.exit(0);
				}, idleMs);
				idleTimer.unref();
			}
		};
		resetIdle();

		stdin.on('end', () => proc.exit(0));
		stdin.on('close', () => proc.exit(0));
		stdout.on('error', () => proc.exit(0));

		let buffer = '';
		stdin.on('data', async (chunk: string) => {
			resetIdle();
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const message = JSON.parse(trimmed) as JsonRpcRequest;
					const send: ProgressSink = (n) => stdout.write(JSON.stringify(n) + '\n');
						const result = await this.handleJsonRpc(message, send);
					if (result !== null) {
						stdout.write(JSON.stringify(result) + '\n');
					}
				} catch {
					stdout.write(JSON.stringify({
						jsonrpc: '2.0',
						id: null,
						error: { code: -32700, message: 'Parse error' },
					}) + '\n');
				}
			}
		});
	}
}
