import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  batonPaths,
  BatonError,
  readState,
  writeState,
  saveSnapshot,
  restoreSnapshot,
  listSnapshots,
} from '../src/core/files.js';
import { defaultState } from '../src/types.js';
import { makeRepo, rmrf } from './helpers.js';

const repos: string[] = [];

async function scaffold(name: string) {
  const repo = await makeRepo(name);
  repos.push(repo.root);
  const paths = batonPaths(repo.root);
  await fs.mkdir(paths.dir, { recursive: true });
  await writeState(repo.root, defaultState());
  return { root: repo.root, paths };
}

afterEach(async () => {
  await Promise.all(repos.map((r) => rmrf(r)));
  repos.length = 0;
});

describe('saveSnapshot', () => {
  it('creates a snapshot file and returns a timestamp string', async () => {
    const { root, paths } = await scaffold('save-snap');
    const ts = await saveSnapshot(root);
    expect(typeof ts).toBe('string');
    expect(ts.length).toBeGreaterThan(0);
    const snapFile = path.join(paths.snapshots, `state-${ts}.json`);
    await expect(fs.access(snapFile)).resolves.toBeUndefined();
  });

  it('snapshot content matches current state', async () => {
    const { root, paths } = await scaffold('save-content');
    const ts = await saveSnapshot(root);
    const snapContent = JSON.parse(
      await fs.readFile(path.join(paths.snapshots, `state-${ts}.json`), 'utf8'),
    );
    const current = await readState(root);
    expect(snapContent).toEqual(current);
  });

  it('auto-creates the .snapshots directory if missing', async () => {
    const { root, paths } = await scaffold('save-mkdir');
    // Remove snapshots dir to test auto-creation
    await rmrf(paths.snapshots);
    await expect(fs.access(paths.snapshots)).rejects.toThrow();
    await saveSnapshot(root);
    await expect(fs.access(paths.snapshots)).resolves.toBeUndefined();
  });
});

describe('listSnapshots', () => {
  it('returns empty array when no snapshots exist', async () => {
    const { root } = await scaffold('list-empty');
    expect(await listSnapshots(root)).toEqual([]);
  });

  it('returns chronologically sorted timestamps', async () => {
    const { root } = await scaffold('list-sorted');
    const ts1 = await saveSnapshot(root);
    // Ensure different timestamp
    await new Promise((r) => setTimeout(r, 50));
    const ts2 = await saveSnapshot(root);
    const list = await listSnapshots(root);
    expect(list).toEqual([ts1, ts2]);
    expect(list.length).toBe(2);
  });
});

describe('restoreSnapshot', () => {
  it('round-trip: save → modify → restore recovers original state', async () => {
    const { root } = await scaffold('roundtrip');
    const original = await readState(root);

    // Save snapshot of the default state
    const ts = await saveSnapshot(root);

    // Modify state (claim the baton)
    const modified = { ...original, holder: 'alice', passCount: 5 };
    await writeState(root, modified);
    expect((await readState(root)).holder).toBe('alice');

    // Restore — should recover the original
    await restoreSnapshot(root, ts);
    const restored = await readState(root);
    expect(restored).toEqual(original);
    expect(restored.holder).toBeNull();
  });

  it('restores the latest snapshot when no timestamp given', async () => {
    const { root } = await scaffold('restore-latest');
    const original = await readState(root);

    await saveSnapshot(root);
    await new Promise((r) => setTimeout(r, 50));

    // Modify and take another snapshot
    const updated = { ...original, passCount: 7 };
    await writeState(root, updated);
    const ts2 = await saveSnapshot(root);

    // Mutate state again
    await writeState(root, { ...original, holder: 'bob' });

    // Restore latest (ts2) — should get passCount: 7, holder: null
    await restoreSnapshot(root);
    const restored = await readState(root);
    expect(restored.passCount).toBe(7);
    expect(restored.holder).toBeNull();
  });

  it('rejects a snapshot with invalid JSON', async () => {
    const { root, paths } = await scaffold('bad-json');
    // Write garbage to a snapshot file
    const fakeTs = '20260101000000000';
    await fs.mkdir(paths.snapshots, { recursive: true });
    await fs.writeFile(
      path.join(paths.snapshots, `state-${fakeTs}.json`),
      '{not valid json!!!',
      'utf8',
    );
    await expect(restoreSnapshot(root, fakeTs)).rejects.toThrow(BatonError);
    // Original state.json must be untouched
    const state = await readState(root);
    expect(state).toEqual(defaultState());
  });

  it('rejects a snapshot that fails schema validation', async () => {
    const { root, paths } = await scaffold('bad-schema');
    const fakeTs = '20260101000000001';
    // Valid JSON but wrong schema (missing required fields, extra keys)
    await fs.mkdir(paths.snapshots, { recursive: true });
    await fs.writeFile(
      path.join(paths.snapshots, `state-${fakeTs}.json`),
      JSON.stringify({ bogus: true, schema: 99 }),
      'utf8',
    );
    await expect(restoreSnapshot(root, fakeTs)).rejects.toThrow(BatonError);
    const state = await readState(root);
    expect(state).toEqual(defaultState());
  });

  it('throws when specified timestamp does not exist', async () => {
    const { root } = await scaffold('restore-missing');
    await saveSnapshot(root);
    await expect(restoreSnapshot(root, 'nonexistent')).rejects.toThrow(BatonError);
  });

  it('throws when no snapshots exist and no timestamp given', async () => {
    const { root } = await scaffold('restore-none');
    await expect(restoreSnapshot(root)).rejects.toThrow(BatonError);
  });
});
