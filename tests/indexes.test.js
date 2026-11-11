import { describe, it, expect, vi } from 'vitest';
import {
  vectorIndexSpec,
  textIndexSpec,
  chunkSearchIndexSpecs,
  ensureSearchIndex,
  vectorIndexDrift,
  waitForSearchIndexes,
  VECTOR_INDEX_NAME,
  TEXT_INDEX_NAME,
} from '../src/db/indexes.js';

/** Fake collection whose listSearchIndexes returns successive snapshots. */
function fakeColl(snapshots) {
  let i = 0;
  return {
    listSearchIndexes: vi.fn((name) => ({
      toArray: async () => {
        const snap = snapshots[Math.min(i++, snapshots.length - 1)];
        return name ? snap.filter((x) => x.name === name) : snap;
      },
    })),
    createSearchIndex: vi.fn(async () => 'ok'),
    updateSearchIndex: vi.fn(async () => {}),
  };
}

describe('index specs', () => {
  it('vector index uses configured dimensions, cosine, and docId filter', () => {
    const spec = vectorIndexSpec(1536);
    expect(spec).toEqual({
      name: VECTOR_INDEX_NAME,
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' },
          { type: 'filter', path: 'docId' },
        ],
      },
    });
  });

  it('rejects invalid dimensions', () => {
    expect(() => vectorIndexSpec(0)).toThrow(RangeError);
    expect(() => vectorIndexSpec(10000)).toThrow(RangeError);
  });

  it('text index maps text and heading with static mappings', () => {
    const { name, type, definition } = textIndexSpec();
    expect(name).toBe(TEXT_INDEX_NAME);
    expect(type).toBe('search');
    expect(definition.mappings.dynamic).toBe(false);
    expect(definition.mappings.fields.text.type).toBe('string');
    expect(definition.mappings.fields.heading.type).toBe('string');
  });

  it('chunkSearchIndexSpecs reads EMBED_DIMENSIONS', () => {
    const [v] = chunkSearchIndexSpecs({ EMBED_DIMENSIONS: 1024 });
    expect(v.definition.fields[0].numDimensions).toBe(1024);
  });
});

describe('ensureSearchIndex', () => {
  const spec = vectorIndexSpec(8);

  it('creates when missing', async () => {
    const coll = fakeColl([[]]);
    expect(await ensureSearchIndex(coll, spec)).toBe('created');
    expect(coll.createSearchIndex).toHaveBeenCalledWith(spec);
  });

  it('skips when it exists', async () => {
    const coll = fakeColl([[{ name: VECTOR_INDEX_NAME }]]);
    expect(await ensureSearchIndex(coll, spec)).toBe('exists');
    expect(coll.createSearchIndex).not.toHaveBeenCalled();
    expect(coll.updateSearchIndex).not.toHaveBeenCalled();
  });

  it('updates when it exists and update=true', async () => {
    const coll = fakeColl([[{ name: VECTOR_INDEX_NAME }]]);
    expect(await ensureSearchIndex(coll, spec, { update: true })).toBe('updated');
    expect(coll.updateSearchIndex).toHaveBeenCalledWith(VECTOR_INDEX_NAME, spec.definition);
  });
});

describe('vectorIndexDrift', () => {
  const spec = vectorIndexSpec(1536);
  it('is empty when matching', () => {
    expect(vectorIndexDrift(spec.definition, spec)).toEqual([]);
  });
  it('reports dimension changes', () => {
    const live = vectorIndexSpec(1024).definition;
    expect(vectorIndexDrift(live, spec)[0]).toMatch(/1024.*1536/);
  });
});

describe('waitForSearchIndexes', () => {
  const names = ['a', 'b'];
  const noSleep = async () => {};

  it('polls until all are READY and queryable', async () => {
    const coll = fakeColl([
      [{ name: 'a', status: 'PENDING' }],
      [{ name: 'a', status: 'BUILDING' }, { name: 'b', status: 'PENDING' }],
      [{ name: 'a', status: 'READY', queryable: true }, { name: 'b', status: 'READY', queryable: true }],
    ]);
    const polls = [];
    await waitForSearchIndexes(coll, names, { sleep: noSleep, onPoll: (s) => polls.push(s) });
    expect(polls).toHaveLength(3);
    expect(polls[0]).toEqual({ a: 'PENDING', b: 'MISSING' });
    expect(polls[2]).toEqual({ a: 'READY', b: 'READY' });
  });

  it('throws when an index FAILED', async () => {
    const coll = fakeColl([[{ name: 'a', status: 'FAILED' }, { name: 'b', status: 'READY', queryable: true }]]);
    await expect(waitForSearchIndexes(coll, names, { sleep: noSleep })).rejects.toThrow(/"a" FAILED/);
  });

  it('times out', async () => {
    let t = 0;
    const coll = fakeColl([[{ name: 'a', status: 'BUILDING' }]]);
    await expect(
      waitForSearchIndexes(coll, names, {
        sleep: noSleep,
        now: () => (t += 1000),
        timeoutMs: 3000,
      }),
    ).rejects.toThrow(/Timed out/);
  });
});
