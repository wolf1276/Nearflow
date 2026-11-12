import { requireAccountId } from '../lib/near/account';
export const EMPTY_CODE_HASH = '11111111111111111111111111111111';
type Request = { request_type: 'view_account'; account_id: string; finality: 'final' }
  | { request_type: 'view_state'; account_id: string; blockId: string; prefix_base64: string };
export type DeploymentQuery = (request: Request) => Promise<unknown>;

export function assertDeploymentRoles(contract: string, oracle: string, token: string) {
  for (const id of [contract, oracle, token]) requireAccountId(id);
  if (new Set([contract, oracle, token]).size !== 3) throw new Error('Use distinct exchange, oracle and token accounts');
}
/** No successful status read is needed: existing code OR data makes an account ineligible. */
export async function assertFreshDeployment(accountId: string, query: DeploymentQuery) {
  requireAccountId(accountId);
  const account = await query({ request_type: 'view_account', account_id: accountId, finality: 'final' });
  if (!account || typeof account !== 'object') throw new Error('Malformed deployment account response');
  const info = account as Record<string, unknown>;
  if (info.code_hash !== EMPTY_CODE_HASH) throw new Error(`Refusing deployment: ${accountId} has code or an unknown code hash`);
  if (typeof info.block_hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(info.block_hash)) throw new Error('Missing finalized deployment block');
  const state = await query({ request_type: 'view_state', account_id: accountId, blockId: info.block_hash, prefix_base64: '' });
  if (!state || typeof state !== 'object') throw new Error('Malformed deployment state response');
  const data = state as Record<string, unknown>;
  if (data.block_hash !== info.block_hash || !Array.isArray(data.values)) throw new Error('Unverified deployment state snapshot');
  if (data.values.length) throw new Error(`Refusing deployment: ${accountId} has existing storage`);
}
