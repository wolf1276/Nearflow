import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Worker, parseNEAR, type NearAccount } from 'near-workspaces';
import { KeyPair, keyStores } from 'near-api-js';

test('actual deployment CLI: fresh accounts, funded-state refusal and recovery on a replacement account', { timeout: 180000 }, async () => {
  const sandbox = await Sandbox.start({ version: '2.14.0' });
  const worker = await Worker.init({ network: 'custom', rpcAddr: sandbox.rpcUrl, rootAccountId: DEFAULT_ACCOUNT_ID, keyStore: new keyStores.InMemoryKeyStore() });
  const directory = await mkdtemp(join(tmpdir(), 'reflex-deploy-'));
  try {
    const root = worker.rootAccount;
    await root.setKey(KeyPair.fromString(DEFAULT_PRIVATE_KEY));
    async function account(name: string) {
      const a = root.getAccount(`${name}.testnet`);
      await a.updateAccount({ amount: parseNEAR('30').toString() });
      const key = KeyPair.fromRandom('ed25519');
      await a.setKey(key); await a.updateAccessKey(key.getPublicKey());
      const file = join(directory, `${name}.json`);
      await writeFile(file, JSON.stringify({ account_id: a.accountId, private_key: key.toString() }), { mode: 0o600 });
      await worker.provider.fastForward(3);
      return { a, file };
    }
    const exchange = await account('rehearsal-exchange'), token = await account('rehearsal-token'), oracle = await account('rehearsal-oracle');
    async function deploy(target: typeof exchange, freshToken: boolean) {
      return promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('scripts/deploy-testnet.ts')], {
        timeout: 45000,
        env: { ...process.env, NEXT_PUBLIC_NEAR_NETWORK: 'testnet', NEXT_PUBLIC_NEAR_RPC_URL: sandbox.rpcUrl,
          NEXT_PUBLIC_NEAR_CONTRACT_ID: target.a.accountId, NEXT_PUBLIC_NEAR_USDC_ID: token.a.accountId,
          NEXT_PUBLIC_ACTIVE_MARKETS: 'NEAR-PERP', NEAR_CONTRACT_KEY_FILE: target.file,
          NEAR_ORACLE_KEY_FILE: oracle.file, NEAR_TEST_TOKEN_KEY_FILE: freshToken ? token.file : '' },
      });
    }
    const first = await deploy(exchange, true);
    assert.match(first.stdout, /Deployed NEARFlow/);
    await worker.provider.fastForward(3);
    const initial = await exchange.a.view<{ total_deposited: string; token_id: string }>('status', {});
    assert.equal(initial.token_id, token.a.accountId); assert.equal(initial.total_deposited, '0');
    await oracle.a.call(token.a, 'faucet', {});
    await oracle.a.call(token.a, 'ft_transfer_call', { receiver_id: exchange.a.accountId, amount: '10000000', msg: '' }, { gas: 250000000000000n, attachedDeposit: 1n });
    await worker.provider.fastForward(3);
    async function state(a: NearAccount) {
      const result = await worker.provider.query<{ block_hash: string; block_height: number; values: Array<{ key: string; value: string }> }>({
        request_type: 'view_state', account_id: a.accountId, prefix_base64: '', finality: 'final',
      });
      return result.values.sort((a, b) => a.key.localeCompare(b.key));
    }
    const exchangeBefore = await state(exchange.a), tokenBefore = await state(token.a);
    await assert.rejects(deploy(exchange, true), /has code/);
    assert.deepEqual(await state(exchange.a), exchangeBefore);
    assert.deepEqual(await state(token.a), tokenBefore);
    assert.equal((await exchange.a.view<{ total_deposited: string }>('status', {})).total_deposited, '10000000');
    // Simulate interruption after code deployment but before initialization.
    const interrupted = await account('rehearsal-interrupted');
    await interrupted.a.deploy(resolve('../contracts/artifacts/nearflow_perps.wasm'));
    await worker.provider.fastForward(3);
    const interruptedBefore = await state(interrupted.a);
    assert.equal(interruptedBefore.length, 0);
    await assert.rejects(deploy(interrupted, false), /has code/);
    assert.deepEqual(await state(interrupted.a), interruptedBefore);
    // Recovery is a new account, never reset/delete/reinitialize an old funded state.
    const replacement = await account('rehearsal-replacement');
    await deploy(replacement, false);
    await worker.provider.fastForward(3);
    assert.equal((await replacement.a.view<{ total_deposited: string }>('status', {})).total_deposited, '0');
    assert.deepEqual(await state(exchange.a), exchangeBefore);
    assert.equal(await token.a.view('ft_balance_of', { account_id: exchange.a.accountId }), '10000000');
    assert.equal((await exchange.a.view<{ balanced: boolean }>('audit', {})).balanced, true);
    console.log('Local Sandbox deployment CLI verified: fresh deployment, funded-state no-op refusal, interrupted-code refusal, replacement recovery; no public credentials/accounts used.');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await worker.tearDown(); await sandbox.tearDown();
  }
});
