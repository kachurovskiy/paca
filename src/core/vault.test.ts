import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vault, VaultCipher } from './vault';
import { testCipher } from './vault-test-fixtures';

afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
  vi.stubGlobal('navigator', { locks: { request: (_key: string, work: () => Promise<unknown>) => work() } });
  return values;
}
describe('password vault', () => {
  it('authenticates ciphertext and context and uses a fresh nonce on each save', async () => {
    const cipher = await testCipher(), data = { secretKey: 'private API secret' };
    const first = await cipher.seal(data, 'credentials'), second = await cipher.seal(data, 'credentials');
    expect(first.iv).not.toBe(second.iv); expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain(data.secretKey);
    expect(await cipher.open(first, 'credentials')).toEqual(data);
    await expect(cipher.open(first, 'watchlist')).rejects.toThrow('authenticated');
    await expect(cipher.open({ ...first, ciphertext: (first.ciphertext[0] === 'A' ? 'B' : 'A') + first.ciphertext.slice(1) }, 'credentials')).rejects.toThrow('authenticated');
    const other = await VaultCipher.derive('different password', new Uint8Array(32));
    await expect(other.open(first, 'credentials')).rejects.toThrow('password');
  });
  it('round-trips all preferences only with the password and never persists it or plaintext', async () => {
    const raw = storage(), password = 'correct horse private password';
    const created = await Vault.unlock(password, true);
    await created.set('credentials', { keyId: 'sensitive-key', secretKey: 'sensitive-secret' });
    await created.set('watchlist', ['PRIVATE']); await created.set('scanner', { enabled: false });
    const persisted = JSON.stringify([...raw]);
    for (const secret of [password, 'sensitive-key', 'sensitive-secret', 'PRIVATE']) expect(persisted).not.toContain(secret);
    await expect(Vault.unlock('wrong password')).rejects.toThrow('password');
    expect(JSON.stringify([...raw])).toBe(persisted);
    const reopened = await Vault.unlock(password);
    expect(reopened.databaseName).toBe(created.databaseName);
    expect(reopened.get('credentials')).toEqual(created.get('credentials'));
    expect(reopened.get('watchlist')).toEqual(['PRIVATE']); expect(reopened.get('scanner')).toEqual({ enabled: false });
    await Promise.all([reopened.set('credentials', { secretKey: 'replacement' }), reopened.set('credentials', undefined)]);
    expect((await Vault.unlock(password)).get('credentials')).toBeUndefined();
  });
  it('does not replace existing or damaged password settings and fails closed on corrupt preferences', async () => {
    const raw = storage(), password = 'synthetic long password';
    await expect(Vault.unlock('short', true)).rejects.toThrow('12'); expect(raw.size).toBe(0);
    const vault = await Vault.unlock(password, true);
    await expect(Vault.unlock(password, true)).rejects.toThrow('already created');
    await vault.set('watchlist', ['SPY']); raw.set('paca.vault.1.watchlist', '{}');
    await expect(Vault.unlock(password)).rejects.toThrow('authenticated');
    raw.set('paca.vault.1', '{');
    await expect(Vault.unlock(password)).rejects.toThrow('damaged'); expect(raw.get('paca.vault.1')).toBe('{');
  });
});
