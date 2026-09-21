

export interface AccountScope {
  readonly broker: string;
  readonly accountId: string;
  readonly environment: 'paper' | 'live';
}

export function accountKey(scope: AccountScope): string {
  if (scope.broker !== 'alpaca' || !scope.accountId?.trim() || !['paper', 'live'].includes(scope.environment)) {
    throw new Error('A stable Alpaca account identity and environment are required.');
  }
  return JSON.stringify([scope.broker, scope.environment, scope.accountId]);
}
