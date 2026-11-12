import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDeploymentRoles, assertFreshDeployment, EMPTY_CODE_HASH, type DeploymentQuery } from '../../scripts/deployment-preflight';
const account = 'fresh.testnet', hash = 'A'.repeat(44);
const fresh = { code_hash: EMPTY_CODE_HASH, block_hash: hash };
function reader(info: unknown, state: unknown): DeploymentQuery {
  return async request => request.request_type === 'view_account' ? info : state;
}
test('deployment only accepts finalized code-free data-free accounts and pins the state read', async () => {
  const calls: unknown[] = [];
  await assertFreshDeployment(account, async request => {
    calls.push(request);
    return request.request_type === 'view_account' ? fresh : { block_hash: hash, values: [] };
  });
  assert.deepEqual(calls, [
    { request_type: 'view_account', account_id: account, finality: 'final' },
    { request_type: 'view_state', account_id: account, blockId: hash, prefix_base64: '' },
  ]);
});
test('existing code or storage is rejected even if status is missing/broken or code was removed', async () => {
  await assert.rejects(assertFreshDeployment(account, reader({ ...fresh, code_hash: 'existing-code' }, { values: [] })), /has code/);
  await assert.rejects(assertFreshDeployment(account, reader(fresh, { block_hash: hash, values: [{ key: 'U1RBVEU=', value: 'b2xk' }] })), /existing storage/);
});
test('RPC errors, malformed responses and mismatched blocks never become fresh-account approval', async () => {
  await assert.rejects(assertFreshDeployment(account, async () => { throw new Error('RPC down'); }), /RPC down/);
  for (const info of [null, {}, { code_hash: EMPTY_CODE_HASH }, { ...fresh, block_hash: '' }])
    await assert.rejects(assertFreshDeployment(account, reader(info, {})));
  for (const state of [null, {}, { block_hash: hash }, { block_hash: 'B'.repeat(44), values: [] }])
    await assert.rejects(assertFreshDeployment(account, reader(fresh, state)));
  await assert.rejects(assertFreshDeployment(account, async request => {
    if (request.request_type === 'view_account') return fresh;
    throw new Error('state unavailable');
  }), /state unavailable/);
});
test('deployment roles cannot overwrite the token with exchange code or use a custody key as oracle', () => {
  assertDeploymentRoles('exchange.testnet', 'oracle.testnet', 'token.testnet');
  for (const roles of [['exchange.testnet', 'exchange.testnet', 'token.testnet'],
    ['exchange.testnet', 'oracle.testnet', 'exchange.testnet'], ['exchange.testnet', 'token.testnet', 'token.testnet']])
    assert.throws(() => assertDeploymentRoles(...roles as [string, string, string]), /distinct/);
});
