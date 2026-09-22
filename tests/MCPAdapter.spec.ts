import { RouterWrapper, MCPAdapter } from '../src/main';
import { IRequest } from 'itty-router';

function createTestRouter() {
	const rw = RouterWrapper.getNew('/v1');

	rw.router.get('/users/:id', (req: IRequest) => {
		return { id: req.params.id };
	});

	rw.router.post('/users', async (req: IRequest) => {
		const body = await req.json();
		return { created: true, ...body };
	});

	rw.router.get('/search', (req: IRequest) => {
		return { q: req.query.q, limit: req.query.limit };
	});

	rw.router.put('/users/:id', async (req: IRequest) => {
		const body = await req.json();
		return { updated: true, id: req.params.id, ...body };
	});

	rw.router.delete('/items/:id', (req: IRequest) => {
		return { deleted: req.params.id };
	});

	return rw;
}

describe('MCPAdapter', () => {
	let rw: RouterWrapper;
	let mcp: MCPAdapter;

	beforeEach(() => {
		rw = createTestRouter();
		mcp = rw.asMCP({ name: 'Test API', version: '1.0.0' });
	});

	describe('toolNameFromRoute', () => {
		it('converts GET route with path param', () => {
			expect(mcp.toolNameFromRoute('GET', '/v1/users/:id')).toBe('get_users_by_id');
		});

		it('converts POST route without params', () => {
			expect(mcp.toolNameFromRoute('POST', '/v1/users')).toBe('post_users');
		});

		it('converts GET route without params', () => {
			expect(mcp.toolNameFromRoute('GET', '/v1/search')).toBe('get_search');
		});

		it('converts PUT route with path param', () => {
			expect(mcp.toolNameFromRoute('PUT', '/v1/users/:id')).toBe('put_users_by_id');
		});
	});

	describe('inferQueryParams', () => {
		it('infers req.query.X patterns', () => {
			const handler = function (req) { return req.query.q; };
			expect(mcp.inferQueryParams([handler])).toContain('q');
		});

		it('infers multiple query params', () => {
			const handler = function (req) { return { q: req.query.q, limit: req.query.limit }; };
			const params = mcp.inferQueryParams([handler]);
			expect(params).toContain('q');
			expect(params).toContain('limit');
		});

		it('infers bracket notation', () => {
			const handler = function (req) { return req.query['filter']; };
			expect(mcp.inferQueryParams([handler])).toContain('filter');
		});

		it('returns empty for no query params', () => {
			const handler = function (req) { return req.params.id; };
			expect(mcp.inferQueryParams([handler])).toEqual([]);
		});
	});

	describe('introspectRoutes', () => {
		it('returns tool definitions for registered routes', () => {
			const tools = mcp.introspectRoutes();
			const names = tools.map((t) => t.name);

			expect(names).toContain('get_users_by_id');
			expect(names).toContain('post_users');
			expect(names).toContain('get_search');
			expect(names).toContain('put_users_by_id');
			expect(names).toContain('delete_items_by_id');
		});

		it('skips wildcard catch-all routes', () => {
			rw.catchNotFound();
			const tools = mcp.introspectRoutes();
			const names = tools.map((t) => t.name);
			// Should not include the catch-all
			expect(names.every((n) => !n.includes('all_'))).toBe(true);
		});

		it('GET route with path param has required param in schema', () => {
			const tools = mcp.introspectRoutes();
			const tool = tools.find((t) => t.name === 'get_users_by_id');
			expect(tool).toBeDefined();
			expect(tool!.inputSchema.properties).toHaveProperty('id');
			expect(tool!.inputSchema.required).toContain('id');
		});

		it('POST route has body property', () => {
			const tools = mcp.introspectRoutes();
			const tool = tools.find((t) => t.name === 'post_users');
			expect(tool).toBeDefined();
			expect(tool!.inputSchema.properties).toHaveProperty('body');
		});

		it('GET route infers query params from handler', () => {
			const tools = mcp.introspectRoutes();
			const tool = tools.find((t) => t.name === 'get_search');
			expect(tool).toBeDefined();
			expect(tool!.inputSchema.properties).toHaveProperty('q');
			expect(tool!.inputSchema.properties).toHaveProperty('limit');
		});
	});

	describe('describeMCP enrichment', () => {
		it('merges description and param metadata', () => {
			rw.describeMCP('/users/:id', 'GET', {
				description: 'Get user by ID',
				params: { id: { description: 'The user UUID' } },
			});
			// Need fresh adapter to pick up meta
			const enrichedMcp = rw.asMCP({ name: 'Test', version: '1.0' });
			const tools = enrichedMcp.introspectRoutes();
			const tool = tools.find((t) => t.name === 'get_users_by_id');
			expect(tool).toBeDefined();
			expect(tool!.description).toBe('Get user by ID');
			expect(tool!.inputSchema.properties.id.description).toBe('The user UUID');
		});
	});

	describe('handleJsonRpc', () => {
		it('handles initialize', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
			});
			expect(result.id).toBe(1);
			expect(result.result.serverInfo.name).toBe('Test API');
			expect(result.result.capabilities.tools).toBeDefined();
		});

		it('handles notifications/initialized with null response', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				method: 'notifications/initialized',
			});
			expect(result).toBeNull();
		});

		it('handles tools/list', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
			});
			expect(result.id).toBe(2);
			expect(Array.isArray(result.result.tools)).toBe(true);
			expect(result.result.tools.length).toBeGreaterThan(0);
		});

		it('handles tools/call for GET with path param', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'get_users_by_id', arguments: { id: '42' } },
			});
			expect(result.id).toBe(3);
			const content = JSON.parse(result.result.content[0].text);
			expect(content.id).toBe('42');
		});

		it('handles tools/call for POST with body', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'post_users', arguments: { body: { name: 'Alice' } } },
			});
			expect(result.id).toBe(4);
			const content = JSON.parse(result.result.content[0].text);
			expect(content.created).toBe(true);
			expect(content.name).toBe('Alice');
		});

		it('handles tools/call for POST with FLAT args — the shape the tool schema advertises', async () => {
			// Regression (bod-browser post_eval, Sep 2026): flat args were diverted to the query
			// string and the body-reading route got {} — "Missing 'script'" while script was passed.
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 41,
				method: 'tools/call',
				params: { name: 'post_users', arguments: { name: 'Alice' } },
			});
			const content = JSON.parse(result.result.content[0].text);
			expect(content.created).toBe(true);
			expect(content.name).toBe('Alice');
		});

		it('explicit body wins over a flat arg of the same name (back-compat)', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 42,
				method: 'tools/call',
				params: { name: 'post_users', arguments: { name: 'Flat', body: { name: 'Nested' } } },
			});
			const content = JSON.parse(result.result.content[0].text);
			expect(content.name).toBe('Nested');
		});

		it('handles tools/call for GET with query params', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: { name: 'get_search', arguments: { q: 'hello', limit: '10' } },
			});
			expect(result.id).toBe(5);
			const content = JSON.parse(result.result.content[0].text);
			expect(content.q).toBe('hello');
			expect(content.limit).toBe('10');
		});

		it('returns error for unknown tool', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 6,
				method: 'tools/call',
				params: { name: 'nonexistent', arguments: {} },
			});
			expect(result.result.isError).toBe(true);
		});

		it('returns error for unknown method', async () => {
			const result = await mcp.handleJsonRpc({
				jsonrpc: '2.0',
				id: 7,
				method: 'unknown/method',
			});
			expect(result.error).toBeDefined();
			expect(result.error.code).toBe(-32601);
		});
	});

	describe('httpHandler', () => {
		it('returns SSE stream for GET request', async () => {
			const req = new Request('http://localhost/mcp', { method: 'GET' });
			const res = await mcp.httpHandler(req);
			expect(res.headers.get('Content-Type')).toBe('text/event-stream');
		});

		it('handles POST JSON-RPC request', async () => {
			const req = new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
			});
			const res = await mcp.httpHandler(req);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(Array.isArray((body as any).result.tools)).toBe(true);
		});

		it('returns 400 for malformed POST body', async () => {
			const req = new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'not json',
			});
			const res = await mcp.httpHandler(req);
			expect(res.status).toBe(400);
		});

		it('returns 204 for notification', async () => {
			const req = new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
			});
			const res = await mcp.httpHandler(req);
			expect(res.status).toBe(204);
		});
	});

	describe('dynamic route reflection', () => {
		it('picks up routes added after asMCP()', async () => {
			const toolsBefore = mcp.introspectRoutes();
			const countBefore = toolsBefore.length;

			rw.router.get('/health', () => ({ status: 'ok' }));

			const toolsAfter = mcp.introspectRoutes();
			expect(toolsAfter.length).toBe(countBefore + 1);
			expect(toolsAfter.map((t) => t.name)).toContain('get_health');
		});
	});
});
