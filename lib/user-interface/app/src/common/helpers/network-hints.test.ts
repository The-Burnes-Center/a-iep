import { describe, expect, it } from 'vitest';
import { isConstrainedConnection } from './network-hints';

describe('isConstrainedConnection', () => {
  it('treats Data Saver as constrained, whatever the link speed', () => {
    expect(isConstrainedConnection({ saveData: true, effectiveType: '4g' })).toBe(true);
  });

  it.each(['slow-2g', '2g', '3g'])('treats an effective type of %s as constrained', (effectiveType) => {
    expect(isConstrainedConnection({ saveData: false, effectiveType })).toBe(true);
  });

  it('leaves a fast connection alone', () => {
    expect(isConstrainedConnection({ saveData: false, effectiveType: '4g' })).toBe(false);
  });

  it('does not treat a missing connection object as slow', () => {
    expect(isConstrainedConnection(undefined)).toBe(false);
    expect(isConstrainedConnection(null)).toBe(false);
  });

  it('does not treat a connection with no reported speed as slow', () => {
    expect(isConstrainedConnection({})).toBe(false);
  });
});
