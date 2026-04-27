import { describe, it, expect } from 'vitest';
import { jaccardSimilarity } from '../src/commands/replay.js';

describe('jaccardSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 1 for two empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1);
  });

  it('returns 0 for completely disjoint strings', () => {
    expect(jaccardSimilarity('apple banana', 'car door')).toBe(0);
  });

  it('returns a value strictly between 0 and 1 for partial overlap', () => {
    const sim = jaccardSimilarity('the quick brown fox', 'the quick red dog');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
    // 2 shared (the, quick) of 6 unique total → 2/6 ≈ 0.33
    expect(sim).toBeCloseTo(2 / 6, 5);
  });

  it('is case-insensitive and ignores punctuation', () => {
    expect(jaccardSimilarity('Hello, world!', 'hello world')).toBe(1);
  });

  it('treats whitespace tokenization consistently', () => {
    expect(jaccardSimilarity('a b c', '  a   b   c  ')).toBe(1);
  });
});
