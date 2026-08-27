import { RouterWrapper, cors } from '../src/main';

// The entry point exports its public surface. This asserted nothing and took a `done`
// callback it never called, so it spent 5s timing out on every run.
test('main exports the public surface', () => {
	expect(typeof RouterWrapper).toBe('function');
	expect(cors).toBeDefined();
});
