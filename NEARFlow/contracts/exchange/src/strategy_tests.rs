fn strategy(e: &mut Exchange, owner: &str, cap: u128) -> strategy::Strategy {
    at(owner, e.strategy_storage_cost().0, 100);
    e.create_strategy(1, U128(cap))
}
fn strategy_deposit(e: &mut Exchange, sender: &str, amount: u128, msg: &str) -> u128 {
    at("usdc.testnet", 0, 100);
    match e.ft_on_transfer(id(sender), U128(amount), msg.into()) {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("Expected unused amount"),
    }
}
fn strategy_result(e: &mut Exchange, request: u64, success: bool) -> bool {
    testing_env!(ctx("desk.testnet", 0, 100).build(), near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(), Default::default(),
        vec![if success { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
    e.resolve_strategy_withdraw(U64(request))
}
#[test]
#[should_panic(expected = "Invalid strategy cap")]
fn strategy_creation_rejects_invalid_cap() {
    let mut e = setup(); strategy(&mut e, "alice.testnet", u128::MAX);
}
#[test]
#[should_panic(expected = "Register storage first")]
fn strategy_creation_requires_registered_owner() {
    let mut e = setup(); strategy(&mut e, "unknown.testnet", 1);
}
#[test]
#[should_panic(expected = "Zero withdrawal")]
fn strategy_zero_withdrawal_rejected() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 1);
    at("alice.testnet", 1, 100); let _ = e.withdraw_strategy(s.strategy_id, U128(0));
}
#[test]
#[should_panic(expected = "Insufficient withdrawal gas")]
fn strategy_withdrawal_requires_callback_gas() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 1);
    let mut b = ctx("alice.testnet", 1, 100); b.prepaid_gas(Gas::from_tgas(60));
    testing_env!(b.build()); let _ = e.withdraw_strategy(s.strategy_id, U128(1));
}
#[test]
#[should_panic(expected = "Strategy not accepting allocation")]
fn strategy_pending_reserve_cannot_be_reallocated_or_overflowed() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10);
    at("alice.testnet", 1, 100); e.allocate_strategy(s.strategy_id, U128(10));
    let _ = e.withdraw_strategy(s.strategy_id, U128(10));
    e.allocate_strategy(s.strategy_id, U128(u128::MAX));
}
#[test]
fn strategy_only_rejects_growing_custody_on_global_pause() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10);
    at("desk.testnet", 1, 100); e.set_paused(true);
    assert_eq!(strategy_deposit(&mut e, "alice.testnet", 1, "strategy:0"), 1);
    assert_eq!(e.get_strategy(s.strategy_id).unwrap().available.0, 0); balanced(&e);
}
#[test]
fn strategy_allocations_partition_custody_and_do_not_touch_positions() {
    let mut e = matched();
    let a = strategy(&mut e, "alice.testnet", 50_000_000);
    let b = strategy(&mut e, "alice.testnet", 30_000_000);
    let before = e.account(&id("alice.testnet")).available.0;
    at("alice.testnet", 1, 100);
    e.allocate_strategy(a.strategy_id, U128(20_000_000));
    e.allocate_strategy(b.strategy_id, U128(10_000_000));
    assert_eq!(e.account(&id("alice.testnet")).available.0, before - 30_000_000);
    assert_eq!(e.pairs.get(&0).unwrap().long_margin.0, 10_000_000);
    assert_eq!(e.total, 300_000_000);
    balanced(&e);
    e.release_strategy(a.strategy_id, U128(5_000_000));
    assert_eq!(e.get_strategy(a.strategy_id).unwrap().available.0, 15_000_000);
    assert_eq!(e.get_strategy(b.strategy_id).unwrap().available.0, 10_000_000);
    assert_eq!(e.account(&id("alice.testnet")).available.0, before - 25_000_000);
    balanced(&e);
}
#[test]
fn strategy_token_deposits_validate_owner_message_cap_and_state() {
    let mut e = setup();
    let s = strategy(&mut e, "alice.testnet", 10_000_000);
    for (sender, amount, msg) in [
        ("bob.testnet", 1, "strategy:0"), ("alice.testnet", 0, "strategy:0"),
        ("alice.testnet", 1, "strategy:999"), ("alice.testnet", 1, "strategy:00"),
        ("alice.testnet", 1, "strategy:+0"), ("alice.testnet", 1, "strategy:-1"),
        ("alice.testnet", 1, "strategy:18446744073709551616"),
        ("alice.testnet", 1, "strategy:"), ("alice.testnet", 11_000_000, "strategy:0"),
    ] { assert_eq!(strategy_deposit(&mut e, sender, amount, msg), amount); }
    let before = e.account(&id("alice.testnet")).available.0;
    assert_eq!(strategy_deposit(&mut e, "alice.testnet", 10_000_000, "strategy:0"), 0);
    assert_eq!(e.get_strategy(s.strategy_id).unwrap().available.0, 10_000_000);
    assert_eq!(e.account(&id("alice.testnet")).available.0, before);
    assert_eq!(e.account(&id("alice.testnet")).stats.deposited.0, 110_000_000);
    assert_eq!(e.total, 310_000_000);
    assert_eq!(strategy_deposit(&mut e, "alice.testnet", 1, "strategy:0"), 1);
    at("alice.testnet", 1, 100);
    e.set_strategy_paused(s.strategy_id, true);
    assert_eq!(strategy_deposit(&mut e, "alice.testnet", 1, "strategy:0"), 1);
    balanced(&e);
}
#[test]
fn strategy_global_deposit_cap_refunds() {
    let mut e = setup(); strategy(&mut e, "alice.testnet", 1_000_000_000);
    assert_eq!(strategy_deposit(&mut e, "alice.testnet", 800_000_000, "strategy:0"), 800_000_000);
    assert_eq!(e.total, 300_000_000);
    balanced(&e);
}
#[test]
fn strategy_pending_is_reserved_recovers_to_same_strategy_and_cannot_free_cap() {
    let mut e = setup();
    let a = strategy(&mut e, "alice.testnet", 10_000_000);
    let b = strategy(&mut e, "bob.testnet", 10_000_000);
    at("alice.testnet", 1, 100);
    e.allocate_strategy(a.strategy_id, U128(10_000_000));
    let _ = e.withdraw_strategy(a.strategy_id, U128(6_000_000));
    assert_eq!(e.get_strategy(a.strategy_id).unwrap().available.0, 4_000_000);
    assert_eq!(e.pending_withdrawals, 6_000_000);
    assert_eq!(e.get_strategy_withdrawal(U64(0)).unwrap().owner_id, id("alice.testnet"));
    balanced(&e);
    assert_eq!(strategy_deposit(&mut e, "alice.testnet", 1, "strategy:0"), 1);
    assert!(!strategy_result(&mut e, 0, false));
    assert_eq!(e.get_strategy(a.strategy_id).unwrap().available.0, 10_000_000);
    assert_eq!(e.get_strategy(b.strategy_id).unwrap().available.0, 0);
    assert_eq!(e.pending_withdrawals, 0);
    assert!(e.get_strategy_withdrawal(U64(0)).is_none());
    balanced(&e);
    at("alice.testnet", 1, 100);
    let _ = e.withdraw_strategy(a.strategy_id, U128(6_000_000));
    assert!(strategy_result(&mut e, 1, true));
    assert_eq!(e.total, 294_000_000);
    assert_eq!(e.account(&id("alice.testnet")).stats.withdrawn.0, 6_000_000);
    assert_eq!(e.get_strategy(a.strategy_id).unwrap().available.0, 4_000_000);
    balanced(&e);
}
#[test]
fn strategy_concurrent_callbacks_out_of_order_and_global_pause_exit() {
    let mut e = setup();
    let a = strategy(&mut e, "alice.testnet", 20_000_000);
    let b = strategy(&mut e, "bob.testnet", 20_000_000);
    for (owner, s) in [("alice.testnet", &a), ("bob.testnet", &b)] {
        at(owner, 1, 100); e.allocate_strategy(s.strategy_id, U128(10_000_000));
        let _ = e.withdraw_strategy(s.strategy_id, U128(2_000_000));
        let _ = e.withdraw_strategy(s.strategy_id, U128(3_000_000));
        balanced(&e);
    }
    for (request, success) in [(3, false), (0, true), (2, true), (1, false)] {
        assert_eq!(strategy_result(&mut e, request, success), success); balanced(&e);
    }
    at("desk.testnet", 1, 100); e.set_paused(true);
    at("alice.testnet", 1, 1000); // no fresh oracle needed to exit settled custody
    e.set_strategy_paused(a.strategy_id, true);
    e.release_strategy(a.strategy_id, U128(1_000_000));
    let _ = e.withdraw_strategy(a.strategy_id, U128(7_000_000));
    assert!(strategy_result(&mut e, 4, true));
    at("alice.testnet", 1, 1000); e.close_strategy(a.strategy_id);
    assert!(e.get_strategy(a.strategy_id).unwrap().closed);
    assert_eq!(e.get_strategy(b.strategy_id).unwrap().available.0, 8_000_000);
    balanced(&e);
}
#[test]
fn strategy_storage_covers_record_and_max_pending_queue() {
    let mut e = setup();
    let owner = format!("{}.testnet", "a".repeat(56)); // Maximum account ID length.
    at(&owner, e.registration_cost, 100); e.storage_deposit(None, Some(true));
    deposit(&mut e, &owner, 10_000_000);
    at(&owner, e.strategy_storage_cost().0, 100);
    let start = env::storage_usage();
    let s = e.create_strategy(1, U128(10_000_000));
    let record_bytes = env::storage_usage() - start;
    // Mock context changes reset the storage-usage counter; measure each phase.
    at(&owner, 1, 100);
    let start = env::storage_usage();
    e.allocate_strategy(s.strategy_id, U128(10_000_000));
    for _ in 0..4 { let _ = e.withdraw_strategy(s.strategy_id, U128(1)); }
    assert!(record_bytes > 0);
    assert!(record_bytes + env::storage_usage() - start <= 4096);
    assert_eq!(e.get_strategies(id(&owner), None, Some(999)).len(), 1);
    assert!(e.get_strategies(id("bob.testnet"), None, None).is_empty());
    assert!(e.get_strategies(id(&owner), Some(1), None).is_empty());
    balanced(&e);
}
#[test]
fn strategy_closed_tombstone_rejects_new_deposits() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10_000_000);
    at("alice.testnet", 1, 100); e.close_strategy(s.strategy_id);
    assert_eq!(strategy_deposit(&mut e, "alice.testnet", 1, "strategy:0"), 1);
    balanced(&e);
}
#[test]
#[should_panic(expected = "Strategy owner only")]
fn strategy_owner_cannot_be_spoofed_by_admin() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10_000_000);
    at("desk.testnet", 1, 100); let _ = e.withdraw_strategy(s.strategy_id, U128(1));
}
#[test]
#[should_panic(expected = "Strategy owner only")]
fn strategy_foreign_release_rejected() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10_000_000);
    at("bob.testnet", 1, 100); e.release_strategy(s.strategy_id, U128(1));
}
#[test]
#[should_panic(expected = "Strategy owner only")]
fn strategy_keeper_cannot_pause() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10_000_000);
    at("keeper.testnet", 1, 100); e.set_strategy_paused(s.strategy_id, true);
}
#[test]
#[should_panic(expected = "Insufficient free collateral")]
fn strategy_cannot_allocate_locked_margin() {
    let mut e = matched(); let s = strategy(&mut e, "alice.testnet", 100_000_000);
    at("alice.testnet", 1, 100); e.allocate_strategy(s.strategy_id, U128(100_000_000));
}
#[test]
#[should_panic(expected = "Strategy not settled and empty")]
fn strategy_cannot_close_with_pending_receipt() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10_000_000);
    at("alice.testnet", 1, 100); e.allocate_strategy(s.strategy_id, U128(1));
    let _ = e.withdraw_strategy(s.strategy_id, U128(1)); e.close_strategy(s.strategy_id);
}
#[test]
#[should_panic(expected = "Pending strategy withdrawal limit")]
fn strategy_pending_request_storage_is_bounded() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10_000_000);
    at("alice.testnet", 1, 100); e.allocate_strategy(s.strategy_id, U128(10));
    for _ in 0..5 { let _ = e.withdraw_strategy(s.strategy_id, U128(1)); }
}
#[test]
#[should_panic(expected = "Unknown or resolved strategy withdrawal")]
fn strategy_callback_replay_rejected() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10_000_000);
    at("alice.testnet", 1, 100); e.allocate_strategy(s.strategy_id, U128(10));
    let _ = e.withdraw_strategy(s.strategy_id, U128(1));
    assert!(strategy_result(&mut e, 0, true)); let _ = strategy_result(&mut e, 0, true);
}
#[test]
#[should_panic(expected = "Callback only")]
fn strategy_callback_external_forgery_rejected() {
    let mut e = setup(); at("alice.testnet", 0, 100); e.resolve_strategy_withdraw(U64(0));
}
#[test]
#[should_panic(expected = "Untrusted token")]
fn strategy_fake_token_deposit_rejected() {
    let mut e = setup(); strategy(&mut e, "alice.testnet", 10_000_000);
    at("alice.testnet", 0, 100); let _ = e.ft_on_transfer(id("alice.testnet"), U128(1), "strategy:0".into());
}
#[test]
#[should_panic(expected = "Insufficient strategy storage deposit")]
fn strategy_creation_storage_is_paid() {
    let mut e = setup(); at("alice.testnet", 1, 100); e.create_strategy(1, U128(1));
}
#[test]
#[should_panic(expected = "Owner strategy capacity")]
fn strategy_owner_storage_growth_is_bounded_even_for_closed_records() {
    let mut e = setup();
    for _ in 0..9 { let s = strategy(&mut e, "alice.testnet", 1); at("alice.testnet", 1, 100); e.close_strategy(s.strategy_id); }
}
#[test]
#[should_panic(expected = "Strategy not accepting allocation")]
fn strategy_paused_allocation_rejected() {
    let mut e = setup(); let s = strategy(&mut e, "alice.testnet", 10_000_000);
    at("alice.testnet", 1, 100); e.set_strategy_paused(s.strategy_id, true); e.allocate_strategy(s.strategy_id, U128(1));
}
#[test]
#[should_panic(expected = "Insufficient strategy collateral")]
fn strategy_withdrawal_cannot_spend_other_strategy() {
    let mut e = setup(); let a = strategy(&mut e, "alice.testnet", 10_000_000);
    let b = strategy(&mut e, "alice.testnet", 10_000_000);
    at("alice.testnet", 1, 100); e.allocate_strategy(a.strategy_id, U128(10));
    let _ = e.withdraw_strategy(b.strategy_id, U128(1));
}
