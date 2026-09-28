import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import {
  matchArtifacts,
  queryWords,
  sortArtifacts,
} from '../../web/control/artifact-filter.js';

type A = Record<string, unknown>;
const list: A[] = [
  {
    id: '1',
    title: 'Launch plan',
    description: 'Dates and owners',
    kind: 'report',
    hostname: 'claude.ai',
    added_by: 'session',
    added_at: '2026-09-20T10:00:00Z',
    session: { id: 's1', name: 'Social Media' },
  },
  {
    id: '2',
    title: 'Story bank',
    description: 'Frames for the flight',
    kind: 'app',
    hostname: 'claude.ai',
    added_by: 'cli',
    added_at: '2026-09-25T10:00:00Z',
    session: { id: 's2', name: 'Agents Manager' },
  },
  {
    id: '3',
    title: 'תוכנית תוויות',
    description: 'Label plan',
    kind: 'preview',
    hostname: 'example.com',
    added_by: 'dashboard',
    added_at: '2026-09-22T10:00:00Z',
  },
  {
    id: '4',
    title: 'Withheld',
    kind: 'report',
    url: null,
    added_by: 'cli',
    added_at: '2026-09-21T10:00:00Z',
  },
];
const ids = (xs: A[]) => xs.map((x) => x.id);

describe('matchArtifacts', () => {
  it('every word must occur across title, description, session, kind or host', () => {
    expect(ids(matchArtifacts(list, 'plan'))).toEqual(['1', '3']);
    expect(ids(matchArtifacts(list, 'plan social'))).toEqual(['1']);
    expect(ids(matchArtifacts(list, 'FLIGHT'))).toEqual(['2']);
    expect(ids(matchArtifacts(list, 'example.com'))).toEqual(['3']);
    expect(ids(matchArtifacts(list, 'preview'))).toEqual(['3']);
    expect(ids(matchArtifacts(list, 'תוויות'))).toEqual(['3']);
  });
  it('added_by is not searched; entries without a url or session still match safely', () => {
    expect(ids(matchArtifacts(list, 'dashboard'))).toEqual([]);
    expect(ids(matchArtifacts(list, 'withheld'))).toEqual(['4']);
  });
  it('an empty or whitespace query returns the list unchanged', () => {
    expect(matchArtifacts(list, '')).toBe(list);
    expect(matchArtifacts(list, '   ')).toBe(list);
  });
  it('uses at most 10 words of at most 60 characters', () => {
    expect(
      queryWords(Array.from({ length: 11 }, (_, i) => `w${i}`).join(' ')),
    ).toHaveLength(10);
    expect(queryWords('x'.repeat(80))[0]).toHaveLength(60);
  });
});

describe('sortArtifacts', () => {
  it('newest (default), oldest, title, session — stable and not mutating', () => {
    const before = ids(list);
    expect(ids(sortArtifacts(list, 'newest'))).toEqual(['2', '3', '4', '1']);
    expect(ids(sortArtifacts(list, 'bogus'))).toEqual(['2', '3', '4', '1']);
    expect(ids(sortArtifacts(list, 'oldest'))).toEqual(['1', '4', '3', '2']);
    expect(ids(sortArtifacts(list, 'title'))).toEqual(['1', '2', '4', '3']);
    expect(ids(sortArtifacts(list, 'session'))).toEqual(['2', '1', '3', '4']);
    expect(ids(list)).toEqual(before);
  });
  it('an entry without added_at sorts as oldest without throwing', () => {
    expect(
      ids(sortArtifacts([...list, { id: '5', title: 'No date' }], 'newest')).at(
        -1,
      ),
    ).toBe('5');
  });
});
