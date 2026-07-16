import { RouterWrapper } from '../src/main';
import { IRequest } from 'itty-router';

/**
 * A GET/DELETE tool's params must come from what the server DECLARED, not from what a regex
 * managed to spot in the handler's transpiled source.
 *
 * inferQueryParams() scans `handler.toString()` for `query.X`. That is defeated by reading params
 * through a helper, by `req.query?.x` (optional chain), by a single-use `const query = req.query`
 * (bundlers inline it), by statement order (Bun merges consecutive consts), and by any minifier.
 * Real servers shipped `properties: {}` for a REQUIRED param — undiscoverable means uncallable.
 * Inference remains a supplement for servers that never declared their params.
 */
function routerWithHelperRead() {
	const rw = RouterWrapper.getNew('');

	// the param is read via a helper, so its name appears NOWHERE in this handler's source —
	// exactly the shape that produced `properties: {}` in the wild
	const readParam = (req: IRequest, key: string) => new URL(req.url, 'http://_').searchParams.get(key);

	rw.describeMCP('/docs/inspect', 'GET', {
		description: 'inspect a doc',
		params: {
			path: { description: 'Absolute path to the file.', type: 'string', required: true },
			full: { description: 'inline instead of spooling', type: 'string' },
		},
	});
	rw.router.get('/docs/inspect', (req: IRequest) => ({ path: readParam(req, 'path'), full: readParam(req, 'full') }));

	// declared + inferred disagree on type/description → declared must win
	rw.describeMCP('/things', 'GET', {
		description: 'list things',
		params: { limit: { description: 'declared description', type: 'number' } },
	});
	rw.router.get('/things', (req: IRequest) => ({ limit: req.query.limit, cursor: req.query.cursor }));

	// nothing declared at all → inference must still work (back-compat for existing servers)
	rw.router.get('/legacy', (req: IRequest) => ({ q: req.query.q }));

	// POST: declared params are BODY fields, not top-level query props
	rw.describeMCP('/things', 'POST', { description: 'create', params: { name: { type: 'string', required: true } } });
	rw.router.post('/things', async (req: IRequest) => await req.json());

	return rw;
}

const toolsOf = (rw: ReturnType<typeof routerWithHelperRead>) => {
	const mcp: any = rw.asMCP({ name: 't', version: '0' });
	return (mcp.introspectRoutes ? mcp.introspectRoutes() : (rw as any).mcpAdapter.introspectRoutes()) as any[];
};

describe('MCPAdapter — declared params are the contract for GET/DELETE', () => {
	let tools: any[];
	beforeAll(() => {
		tools = toolsOf(routerWithHelperRead());
	});
	const byName = (n: string) => tools.find((t) => t.name === n);

	it('advertises a declared param even when the handler reads it via a helper', () => {
		const schema = byName('get_docs_inspect').inputSchema;
		expect(Object.keys(schema.properties).sort()).toEqual(['full', 'path']);
	});

	it('honours declared required', () => {
		expect(byName('get_docs_inspect').inputSchema.required).toContain('path');
	});

	it('declared metadata wins over the inferred default', () => {
		const p = byName('get_things').inputSchema.properties;
		expect(p.limit.type).toBe('number');
		expect(p.limit.description).toBe('declared description');
	});

	it('still infers params that were never declared (back-compat)', () => {
		// `cursor` is only visible via source inference; `q` on /legacy has no describeMCP at all
		expect(Object.keys(byName('get_things').inputSchema.properties)).toContain('cursor');
		expect(Object.keys(byName('get_legacy').inputSchema.properties)).toContain('q');
	});

	it('does not turn POST declared params into top-level query props', () => {
		const schema = byName('post_things').inputSchema;
		expect(Object.keys(schema.properties)).toEqual(['body']);
		expect(schema.properties.body.properties.name).toBeDefined();
	});
});
