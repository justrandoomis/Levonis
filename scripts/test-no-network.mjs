// Unit tests supply their own in-memory transports. A missing mock must fail
// locally instead of contacting a customer notification or payment provider.
globalThis.fetch = async () => { throw new Error('External network is disabled in the unit-test process; provide an explicit transport mock.'); };
