import { useState } from 'preact/hooks';
import { hasVault, Vault } from '../core/vault';
import { App } from './app';

export function PasswordGate() {
  const [initial] = useState(() => {
    try { return { create: !hasVault(), error: '' }; }
    catch { return { create: false, error: 'Browser storage is unavailable. Enable it and reload to unlock Paca.' }; }
  });
  const [vault, setVault] = useState<Vault | null>(null);
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(initial.error);
  const unlock = async () => {
    if (busy || initial.error) return;
    if (initial.create && password !== confirmation) { setError('Passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      const opened = await Vault.unlock(password, initial.create);
      setPassword(''); setConfirmation(''); setVault(opened);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to unlock saved data.'); }
    finally { setBusy(false); }
  };
  if (vault) return <App vault={vault} />;
  return <main class="unlock-page"><section class="panel connect-dialog" aria-labelledby="unlock-heading">
    <a class="brand" href="#">paca<span>trading terminal</span></a>
    <h1 id="unlock-heading">{initial.create ? 'Protect your workspace' : 'Unlock your workspace'}</h1>
    <p>{initial.create ? 'Create a password to encrypt your saved API keys and workspace data in this browser.' : 'Enter your password to decrypt your saved API keys and workspace data.'}</p>
    <form onSubmit={event => { event.preventDefault(); void unlock(); }} aria-busy={busy}>
      <label>Password<input type="password" name="password" autoComplete={initial.create ? 'new-password' : 'current-password'} autoFocus required minLength={initial.create ? 12 : undefined}
        disabled={busy || !!initial.error} value={password} onInput={event => setPassword(event.currentTarget.value)} /></label>
      {initial.create && <label>Confirm password<input type="password" name="confirmation" autoComplete="new-password" required minLength={12}
        disabled={busy} value={confirmation} onInput={event => setConfirmation(event.currentTarget.value)} /></label>}
      {initial.create && <p>Use at least 12 characters. Keep your password safe: it cannot be recovered, and saved data cannot be decrypted without it.</p>}
      {error && <p role="alert">{error}</p>}
      <button class="primary" disabled={busy || !!initial.error || !password || initial.create && !confirmation}>{busy ? 'Unlocking…' : initial.create ? 'Create password' : 'Unlock'}</button>
    </form>
    <p class="unlock-note">Your password stays on this device. Each new tab or page reload requires it again.</p>
  </section></main>;
}
