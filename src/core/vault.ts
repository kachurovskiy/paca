const HEADER_KEY = 'paca.vault.1';
const PREFIX = `${HEADER_KEY}.`;
const ITERATIONS = 600_000;
const encoder = new TextEncoder(), decoder = new TextDecoder();
export interface Sealed { iv: string; ciphertext: string }
interface Header { version: 1; salt: string; check: Sealed }
const encode = (bytes: Uint8Array): string => {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
};
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), character => character.charCodeAt(0));

/** Keys are non-extractable and live only in this page's memory. */
export class VaultCipher {
  private constructor(private readonly encryption: CryptoKey, private readonly indexing: CryptoKey) {}
  static async derive(password: string, salt: Uint8Array): Promise<VaultCipher> {
    if (!globalThis.crypto?.subtle) throw new Error('Password protection requires HTTPS or localhost and Web Crypto support.');
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, 512));
    try {
      const encryption = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const indexing = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new VaultCipher(encryption, indexing);
    } finally { bits.fill(0); }
  }
  async seal(value: unknown, context: string): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, this.encryption, encoder.encode(JSON.stringify(value)));
    return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
  }
  async open(value: Sealed, context: string): Promise<unknown> {
    try {
      if (!value || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string' || decode(value.iv).length !== 12) throw new Error();
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv), additionalData: encoder.encode(context) }, this.encryption, decode(value.ciphertext));
      return JSON.parse(decoder.decode(clear));
    } catch { throw new Error('Encrypted data could not be authenticated. The password is incorrect or the stored data is damaged.'); }
  }
  async index(value: unknown): Promise<string> {
    return encode(new Uint8Array(await crypto.subtle.sign('HMAC', this.indexing, encoder.encode(JSON.stringify(value)))));
  }
}

export function hasVault(): boolean { return localStorage.getItem(HEADER_KEY) !== null; }

export class Vault {
  readonly databaseName: string;
  private values = new Map<string, unknown>();
  private pending: Promise<void> = Promise.resolve();
  private constructor(readonly cipher: VaultCipher, private readonly header: string, salt: string) {
    this.databaseName = `paca-vault-1-${salt}`;
  }
  static async unlock(password: string, create = false): Promise<Vault> {
    if (!navigator.locks) throw new Error('Password protection requires browser Web Locks support.');
    return navigator.locks.request('paca-vault-setup', async () => {
      let raw = localStorage.getItem(HEADER_KEY);
      if (create && raw !== null) throw new Error('A password was already created in another tab. Reload to unlock.');
      if (!create && raw === null) throw new Error('Saved password settings are missing. Reload to create a password.');
      let header: Header;
      if (create) {
        if (password.length < 12) throw new Error('Use at least 12 characters for your password.');
        const salt = crypto.getRandomValues(new Uint8Array(32)), cipher = await VaultCipher.derive(password, salt);
        header = { version: 1, salt: encode(salt), check: await cipher.seal('paca-vault-1', HEADER_KEY) };
        raw = JSON.stringify(header);
        localStorage.setItem(HEADER_KEY, raw);
        return new Vault(cipher, raw, header.salt);
      }
      try {
        header = JSON.parse(raw!);
        if (header.version !== 1 || typeof header.salt !== 'string' || decode(header.salt).length !== 32) throw new Error();
      } catch { throw new Error('Saved password settings are damaged or incompatible. Stored data has not been changed.'); }
      const cipher = await VaultCipher.derive(password, decode(header.salt));
      if (await cipher.open(header.check, HEADER_KEY) !== 'paca-vault-1') throw new Error('Saved password settings are damaged.');
      const vault = new Vault(cipher, raw!, header.salt);
      for (const name of ['credentials', 'watchlist', 'scanner']) {
        const value = localStorage.getItem(PREFIX + name);
        if (value !== null) {
          let sealed: Sealed;
          try { sealed = JSON.parse(value); } catch { throw new Error('Encrypted preferences are damaged. Stored data has not been changed.'); }
          vault.values.set(name, await cipher.open(sealed, PREFIX + name));
        }
      }
      return vault;
    });
  }
  get(name: string): unknown { return this.values.get(name); }
  set(name: string, value: unknown): Promise<void> {
    // Serialize writes, including Forget, so a late encryption cannot restore deleted keys.
    const task = this.pending.then(async () => {
      const sealed = value === undefined ? null : await this.cipher.seal(value, PREFIX + name);
      if (localStorage.getItem(HEADER_KEY) !== this.header) throw new Error('Password settings changed. Reload to unlock again.');
      if (sealed) localStorage.setItem(PREFIX + name, JSON.stringify(sealed)); else localStorage.removeItem(PREFIX + name);
      if (value === undefined) this.values.delete(name); else this.values.set(name, structuredClone(value));
    });
    this.pending = task.catch(() => {});
    return task;
  }
}
