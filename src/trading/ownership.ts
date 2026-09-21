import { accountKey, type AccountScope } from '../core/account';

/** Lifetime ownership only. Command serialization belongs to Trading. */
export class AccountOwnership {
  private held = true;
  private constructor(readonly scope: AccountScope, private readonly unlock: () => void,
    private readonly released: Promise<unknown>) {}

  static async acquire(scope: AccountScope, locks: LockManager | null = globalThis.navigator?.locks ?? null): Promise<AccountOwnership> {
    if (!locks) throw new Error('Web Locks are required. Execution is unavailable in this browser.');
    const name = `paca:account:${accountKey(scope)}`;
    let unlock!: () => void;
    const lifetime = new Promise<void>(resolve => { unlock = resolve; });
    let accepted!: () => void, refused!: (error: unknown) => void;
    const acquired = new Promise<void>((resolve, reject) => { accepted = resolve; refused = reject; });
    const released = locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) { refused(new Error('This account is connected in another tab. Disconnect there, then reconnect here.')); return; }
      accepted();
      await lifetime;
    });
    void released.catch(refused);
    await acquired;
    return new AccountOwnership({ ...scope }, unlock, released);
  }

  assert(): void { if (!this.held) throw new Error('The account session no longer owns execution.'); }
  async release(): Promise<void> { this.held = false; this.unlock(); await this.released; }
}
