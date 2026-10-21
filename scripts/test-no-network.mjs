// Unit tests supply their own in-memory transports. A missing mock must fail
// locally instead of contacting a customer notification or payment provider.
globalThis.fetch = async () => { throw new Error('External network is disabled in the unit-test process; provide an explicit transport mock.'); };

// THROWAWAY (ci/timebomb only, never merged): every test process sees the clock 45 days ahead.
{
  const OFFSET = 45 * 86_400_000;
  const RealDate = Date;
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + OFFSET).toString();
    return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + OFFSET);
  }
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = () => RealDate.now() + OFFSET;
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;
  globalThis.Date = ShiftedDate;
}
