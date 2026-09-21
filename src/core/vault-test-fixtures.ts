import { VaultCipher } from './vault';

let cipher: Promise<VaultCipher> | undefined;
export const testCipher = (): Promise<VaultCipher> => cipher ??= VaultCipher.derive('synthetic test password', new Uint8Array(32));
