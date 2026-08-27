import { RouterWrapper } from '../src/main';
import { IRequest } from 'itty-router';

/**
 * A tool call dispatches a freshly-built Request to the matched route, so nothing from the
 * inbound MCP request reaches it. That made every header-authenticated route unreachable over
 * MCP: it saw no credential and refused. `forwardHeaders` names the headers to carry across.
 */
function createRouter() {
	const rw = RouterWrapper.getNew('/v1');
	// a route that authenticates the way real admin surfaces do
	rw.router.get('/secret', (req: IRequest) => {
		if (req.headers.get('x-admin-key') !== 'letmein') return new Response('forbidden', { status: 403 });
		return { ok: true, seen: req.headers.get('x-admin-key') };
	});
	rw.router.get('/echo', (req: IRequest) => ({
		admin: req.headers.get('x-admin-key'),
		other: req.headers.get('x-other'),
		auth: req.headers.get('authorization'),
	}));
	return rw;
}

const rpc = (mcp: any, name: string, headers: Record<string, string> = {}) =>
	mcp.httpHandler(new Request('http://localhost/mcp', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
	})).then((r: Response) => r.json()).then((d: any) => d.result);

/** The tool result's payload, parsed out of the MCP text envelope. */
const payload = (res: any) => {
	const text = res?.content?.[0]?.text ?? '';
	try { return JSON.parse(text); } catch { return text; }
};

describe('MCPAdapter forwardHeaders', () => {
	it('without the option, an inbound header does not reach the route (the old behaviour)', async () => {
		const mcp = createRouter().asMCP({ name: 'T' });
		const res = await rpc(mcp, 'get_secret', { 'x-admin-key': 'letmein' });
		expect(res.isError).toBe(true);
		expect(payload(res)).toContain('forbidden');
	});

	it('forwards a named header so a header-gated route authenticates', async () => {
		const mcp = createRouter().asMCP({ name: 'T', forwardHeaders: ['x-admin-key'] });
		const res = await rpc(mcp, 'get_secret', { 'x-admin-key': 'letmein' });
		expect(res.isError).toBeFalsy();
		expect(payload(res).ok).toBe(true);
	});

	it('still refuses when the caller sends no header — the gate is not weakened', async () => {
		const mcp = createRouter().asMCP({ name: 'T', forwardHeaders: ['x-admin-key'] });
		const res = await rpc(mcp, 'get_secret');
		expect(res.isError).toBe(true);
		expect(payload(res)).toContain('forbidden');
	});

	it('forwards ONLY the named headers, never the inbound Authorization by default', async () => {
		const mcp = createRouter().asMCP({ name: 'T', forwardHeaders: ['x-admin-key'] });
		const res = await rpc(mcp, 'get_echo', {
			'x-admin-key': 'letmein',
			'x-other': 'nope',
			authorization: 'Bearer server-own-token',
		});
		const body = payload(res);
		expect(body.admin).toBe('letmein');
		expect(body.other).toBeNull();
		expect(body.auth).toBeNull();
	});

	it('REFUSES to forward authorization/cookie even when explicitly declared', async () => {
		// On a shared control plane any tenant can declare forwardHeaders. Honouring
		// `authorization` would (a) hand that tenant's handlers the caller's MCP
		// credential and (b) — since forwarded headers are applied last — overwrite the
		// adapter's own internal Bearer on every dispatched request.
		const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
		const mcp = createRouter().asMCP({ name: 'T', forwardHeaders: ['Authorization', 'Cookie', 'x-admin-key'] });
		const res = await rpc(mcp, 'get_echo', {
			authorization: 'Bearer caller-mcp-credential',
			cookie: 'session=abc',
			'x-admin-key': 'letmein',
		});
		const body = payload(res);
		expect(body.auth).toBeNull();
		expect(body.admin).toBe('letmein'); // the legitimate one still forwards
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('is case-insensitive about the configured name', async () => {
		const mcp = createRouter().asMCP({ name: 'T', forwardHeaders: ['X-Admin-Key'] });
		const res = await rpc(mcp, 'get_secret', { 'x-admin-key': 'letmein' });
		expect(res.isError).toBeFalsy();
	});
});
