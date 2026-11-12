#!/usr/bin/env python3
"""Offline evidence checks only. Success is NOT execution/deployment approval."""
import json
import re
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def constant_product(amount, reserve_in, reserve_out, fee_bps):
    assert amount > 0 and reserve_in > 0 and reserve_out > 0
    assert 0 <= fee_bps < 10_000
    weighted = amount * (10_000 - fee_bps)
    return weighted * reserve_out // (10_000 * reserve_in + weighted)


def verify():
    assert constant_product(100, 1000, 2000, 30) == 181
    evidence = json.loads((HERE / "option2-latest-check.json").read_text())
    proposal = json.loads((HERE / "fresh-exchange-proposal.json").read_text())
    assert evidence["scope"] == "READ_ONLY_TESTNET_NOT_SIGNED_EXECUTION"
    assert evidence["approved_for_execution"] is False
    assert evidence["block"]["height"] == 277330507
    assert evidence["block"]["hash"] == "5kKtXYVAUo9ZYpUTwotMjkoZZx3QUYHFFSCvgMgxemgR"
    assert evidence["tokens"]["wrap.testnet"]["metadata"]["decimals"] == 24
    assert len(evidence["quotes"]) == 8
    verified = rejected = 0
    for quote in evidence["quotes"]:
        pool = evidence["pools"][str(quote["pool_id"])]
        if isinstance(quote["result"], dict):
            assert pool["pool_kind"] == "DEGEN_SWAP"
            assert "E129: Degens expired" in quote["result"]["error"]
            rejected += 1
            continue
        assert pool["pool_kind"] == "SIMPLE_POOL"
        tokens = pool["token_account_ids"]
        assert len(tokens) == 2
        incoming, outgoing = tokens.index(quote["token_in"]), tokens.index(quote["token_out"])
        assert incoming != outgoing
        collateral = next(token for token in tokens if token != "wrap.testnet")
        assert evidence["tokens"][collateral]["metadata"]["decimals"] == 6
        result = constant_product(int(quote["amount_in"]), int(pool["amounts"][incoming]), int(pool["amounts"][outgoing]), pool["total_fee"])
        assert result == int(quote["result"])
        if quote["token_out"] == "wrap.testnet":
            size, retained_dust = divmod(result, 10**18)
            assert result == size * 10**18 + retained_dust
            assert 0 <= retained_dust < 10**18
        verified += 1
    assert (verified, rejected) == (6, 2)

    funding = (ROOT / "packages/funding/src/lib.rs").read_text()
    cap = int(re.search(r"pub const CAP: i64 = ([\d_]+);", funding).group(1).replace("_", ""))
    assert cap == 2000
    feedback = (ROOT / "packages/risk/feedback.ts").read_text()
    assert "p.horizonSeconds > 3600" in feedback
    maximum_hourly_funding_bps = Fraction(cap * 10_000, 1_000_000)
    # Even favoring spot by 3% and perp by the 5% opening band cannot make
    # the captured comparable-notional roundtrip spot fees fit this horizon.
    for pool in evidence["pools"].values():
        if pool["pool_kind"] == "SIMPLE_POOL":
            minimum_relative_spot_fees = Fraction(2 * pool["total_fee"] * 97, 105)
            assert minimum_relative_spot_fees > maximum_hourly_funding_bps

    for field in ["implementation_approved", "deployment_approved", "spending_approved", "real_execution_enabled"]:
        assert proposal[field] is False
    for field in ["selected_collateral", "selected_pool_id", "exchange_account_id", "oracle_account_id", "executor_binding", "approved_policy_hash", "approved_native_near_budget", "approved_token_budget"]:
        assert proposal[field] is None
    assert proposal["transactions"] == []
    assert proposal["requirements"]["fresh_exchange_account_only"] is True
    assert proposal["requirements"]["preserve_every_existing_funded_deployment"] is True
    print(f"Evidence consistent: {verified} integer quote matches, {rejected} documented quote failures, exact base/dust conversions.")
    print("Captured simple-pool fees exceed the existing one-hour funding cap before other costs.")
    print("V8 execution/deployment readiness: BLOCKED. No network calls or transactions performed by this verifier.")


if __name__ == "__main__":
    verify()
