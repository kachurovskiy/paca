import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Sealed, VaultCipher } from './vault';

type Store = 'runs' | 'manualCommands' | 'research' | 'reviews';
interface EncryptedRow extends Sealed { key: string; scope: string; active: string }
interface Schema extends DBSchema {
  runs: { key: string; value: EncryptedRow; indexes: { scope: string; active: string } };
  manualCommands: { key: string; value: EncryptedRow; indexes: { scope: string; active: string } };
  research: { key: string; value: EncryptedRow; indexes: { scope: string; active: string } };
  reviews: { key: string; value: EncryptedRow; indexes: { scope: string; active: string } };
}

/** Only ciphertext and keyed, opaque lookup tokens reach IndexedDB. */
export class Database {
  constructor(private readonly db: IDBPDatabase<Schema>, private readonly cipher: VaultCipher) {}
  close(): void { this.db.close(); }
  private token(store: Store, index: string, value: unknown): Promise<string> { return this.cipher.index([store, index, value]); }
  private async key(store: Store, key: string): Promise<string> {
    let scope = '';
    try { const parts = JSON.parse(key); if (Array.isArray(parts) && typeof parts[0] === 'string') scope = parts[0]; } catch { /* Validation belongs to the record owner. */ }
    return `${await this.token(store, 'scope', scope)}:${await this.token(store, 'key', key)}`;
  }
  private async metadata(store: Store, value: unknown) {
    const row = value as { key: string; scope?: string; active?: number };
    if (!row || typeof row.key !== 'string') throw new Error('Stored records require a stable key.');
    return { key: await this.key(store, row.key), scope: await this.token(store, 'scope', row.scope ?? ''),
      active: await this.token(store, 'active', [row.scope ?? '', row.active ?? null]) };
  }
  private context(store: Store, row: Pick<EncryptedRow, 'key' | 'scope' | 'active'>): string {
    return JSON.stringify([this.db.name, store, row.key, row.scope, row.active]);
  }
  private async encrypt(store: Store, value: unknown): Promise<EncryptedRow> {
    value = structuredClone(value);
    const metadata = await this.metadata(store, value);
    return { ...metadata, ...await this.cipher.seal(value, this.context(store, metadata)) };
  }
  private async decrypt(store: Store, row: EncryptedRow): Promise<unknown> {
    const value = await this.cipher.open(row, this.context(store, row)), expected = await this.metadata(store, value);
    if (expected.key !== row.key || expected.scope !== row.scope || expected.active !== row.active) throw new Error('Encrypted record indexes are damaged.');
    return value;
  }
  async get(store: Store, key: string): Promise<unknown> {
    const row = await this.db.get(store, await this.key(store, key));
    return row === undefined ? undefined : this.decrypt(store, row);
  }
  async getAll(store: Store): Promise<unknown[]> { return Promise.all((await this.db.getAll(store)).map(row => this.decrypt(store, row))); }
  async getAllFromIndex(store: Store, index: 'scope' | 'active', value: string | [string, number]): Promise<unknown[]> {
    return Promise.all((await this.db.getAllFromIndex(store, index, await this.token(store, index, value))).map(row => this.decrypt(store, row)));
  }
  async countScopeKeys(store: Store, scope: string): Promise<number> {
    const prefix = `${await this.token(store, 'scope', scope)}:`;
    return this.db.count(store, IDBKeyRange.bound(prefix, prefix + '\uffff'));
  }
  async countFromIndex(store: Store, index: 'scope' | 'active', value: string | [string, number]): Promise<number> {
    return this.db.countFromIndex(store, index, await this.token(store, index, value));
  }
  async put(store: Store, value: unknown): Promise<void> {
    // Crypto completes BEFORE the transaction: idle IndexedDB transactions auto-commit.
    const row = await this.encrypt(store, value), tx = this.db.transaction(store, 'readwrite', { durability: 'strict' });
    await Promise.all([tx.store.put(row), tx.done]);
  }
  async update(store: Store, key: string, change: (value: unknown) => unknown): Promise<void> {
    const token = await this.key(store, key);
    for (;;) {
      const prior = await this.db.get(store, token);
      const next = change(prior === undefined ? undefined : await this.decrypt(store, prior));
      const row = await this.encrypt(store, next);
      if (row.key !== token) throw new Error('An update cannot change its record key.');
      // Compare and commit atomically after encryption; retry concurrent edits without losing them.
      const tx = this.db.transaction(store, 'readwrite', { durability: 'strict' });
      try {
        const current = await tx.store.get(token);
        if (JSON.stringify(current) !== JSON.stringify(prior)) { await tx.done; continue; }
        await tx.store.put(row); await tx.done; return;
      } catch (error) { await tx.done.catch(() => {}); throw error; }
    }
  }
}

export async function openDatabase(cipher: VaultCipher, name: string): Promise<Database> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is required for execution.');
  let blocked = false;
  let rejectBlocked!: (error: Error) => void;
  const unavailable = new Promise<never>((_resolve, reject) => { rejectBlocked = reject; });
  const opening = openDB<Schema>(name, 1, {
    upgrade(db) {
      for (const name of ['runs', 'manualCommands', 'research', 'reviews'] as const) {
        const store = db.createObjectStore(name, { keyPath: 'key' });
        store.createIndex('scope', 'scope'); store.createIndex('active', 'active');
      }
    },
    blocked() { blocked = true; rejectBlocked(new Error('Close other Paca tabs before opening encrypted storage.')); },
    blocking() { void opening.then(db => db.close()); },
  });
  void opening.then(db => { if (blocked) db.close(); }).catch(() => {});
  return new Database(await Promise.race([opening, unavailable]), cipher);
}
