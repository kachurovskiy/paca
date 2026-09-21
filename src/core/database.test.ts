import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { testCipher } from './vault-test-fixtures';

describe('encrypted durable database', () => {
  it('encrypts every store including account identifiers and preserves indexed reads after reopening', async () => {
    const cipher = await testCipher(), name = `encrypted-${crypto.randomUUID()}`;
    let db = await openDatabase(cipher, name);
    const scope = 'private-account', value = { key: JSON.stringify([scope, 'private-id']), scope, active: 1, secret: 'private-payload' };
    for (const store of ['runs', 'manualCommands', 'research', 'reviews'] as const) await db.put(store, value);
    db.close(); db = await openDatabase(cipher, name);
    const raw = await openDB(name);
    try {
      for (const store of ['runs', 'manualCommands', 'research', 'reviews'] as const) {
        const rows = await raw.getAll(store), text = JSON.stringify(rows);
        for (const clear of [scope, 'private-id', 'private-payload']) expect(text).not.toContain(clear);
        expect(await db.get(store, value.key)).toEqual(value);
        expect(await db.getAllFromIndex(store, 'scope', scope)).toEqual([value]);
        expect(await db.getAllFromIndex(store, 'active', [scope, 1])).toEqual([value]);
        expect(await db.countScopeKeys(store, scope)).toBe(1);
      }
    } finally { db.close(); raw.close(); }
  });
  it('rejects modified ciphertext and swapped records without discarding the evidence', async () => {
    const name = `tampered-${crypto.randomUUID()}`, db = await openDatabase(await testCipher(), name), raw = await openDB(name);
    try {
      const scope = 'account';
      await db.put('runs', { key: JSON.stringify([scope, 'one']), scope, active: 1 });
      await db.put('runs', { key: JSON.stringify([scope, 'two']), scope, active: 1 });
      const [one, two] = await raw.getAll('runs');
      const damaged = { ...one, iv: two.iv, ciphertext: two.ciphertext };
      await raw.put('runs', damaged);
      await expect(db.getAll('runs')).rejects.toThrow('authenticated');
      expect(await raw.get('runs', one.key)).toEqual(damaged);
    } finally { db.close(); raw.close(); }
  });
  it('commits concurrent encrypted updates without losing either change', async () => {
    const name = `concurrent-${crypto.randomUUID()}`, cipher = await testCipher();
    const first = await openDatabase(cipher, name), second = await openDatabase(cipher, name);
    const key = JSON.stringify(['account', 'counter']);
    try {
      await first.put('research', { key, scope: 'account', count: 0 });
      const increment = (value: unknown) => { const row = value as { count: number }; return { ...row, count: row.count + 1 }; };
      await Promise.all([first.update('research', key, increment), second.update('research', key, increment)]);
      expect(await first.get('research', key)).toMatchObject({ count: 2 });
    } finally { first.close(); second.close(); }
  });
});
