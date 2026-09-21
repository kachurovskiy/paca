import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/** A clean namespace. Old Paca databases are never opened or migrated. */
export const DATABASE_NAME = 'paca-session-snapshots';
interface Schema extends DBSchema {
  runs: { key: string; value: unknown; indexes: { scope: string; active: [string, number] } };
  manualCommands: { key: string; value: unknown; indexes: { scope: string } };
  research: { key: string; value: unknown; indexes: { scope: string } };
  reviews: { key: string; value: unknown };
}
export type Database = IDBPDatabase<Schema>;

export async function openDatabase(name = DATABASE_NAME): Promise<Database> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is required for execution.');
  let blocked = false;
  let rejectBlocked!: (error: Error) => void;
  const unavailable = new Promise<never>((_resolve, reject) => { rejectBlocked = reject; });
  const opening = openDB<Schema>(name, 1, {
    upgrade(db) {
      const runs = db.createObjectStore('runs', { keyPath: 'key' });
      runs.createIndex('scope', 'scope');
      runs.createIndex('active', ['scope', 'active']);
      const manual = db.createObjectStore('manualCommands', { keyPath: 'key' });
      manual.createIndex('scope', 'scope');
      const research = db.createObjectStore('research', { keyPath: 'key' });
      research.createIndex('scope', 'scope');
      db.createObjectStore('reviews', { keyPath: 'key' });
    },
    blocked() { blocked = true; rejectBlocked(new Error('Close other Paca tabs before opening execution storage.')); },
    blocking(_current, _next, _event) { void opening.then(db => db.close()); },
  });
  void opening.then(db => { if (blocked) db.close(); }).catch(() => {});
  return Promise.race([opening, unavailable]);
}
