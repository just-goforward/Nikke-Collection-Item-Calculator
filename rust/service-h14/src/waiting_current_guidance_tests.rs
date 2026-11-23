// Differential oracle: plain Engine::get never initializes guidance. Equal
// color actions deliberately require all exact root ties, not just one winner.
fn current_guidance_engine() -> Engine {
    let mut edges: Vec<_> = (0..=TERMINAL)
        .map(|s| [[1000, TERMINAL, (s + 1).min(TERMINAL)]; 3])
        .collect();
    for s in 560..TERMINAL {
        edges[s] = [[500, TERMINAL, s + 1]; 3];
    }
    Engine::new(Init {
        edges,
        caps: vec![[40; 3]; 601],
        weights: std::array::from_fn(|_| wire(&Q::one())),
        deadline_at: f64::MAX,
        max_memo_entries: 250000,
        max_support_points: 25000,
    })
    .unwrap()
}

#[test]
fn current_mixed_inventory_matches_unguided_exact_values_masks_and_batches() {
    for (stock, limit, uses) in [
        ([200, 100, 50], 100, 10),
        ([120, 110, 100], 4, 4),
        ([209, 109, 59], 0, 0),
    ] {
        let mut plain = current_guidance_engine();
        let units = stock.map(|pieces| pieces / 10);
        let exact = plain.get(560, units, true).unwrap();
        assert_eq!(exact.mask, 7);
        assert!(plain.arena.is_none() && plain.primary.is_empty());
        let mut guided = current_guidance_engine();
        let current = guided.current(560, stock, limit).unwrap();
        // This is evidence that Current actually entered guidance, rather than
        // merely testing a helper's eligibility threshold. Current frees arena.
        assert!(!guided.primary.is_empty());
        assert!(guided.arena.is_none());
        assert_eq!(current["value"], json!(plain.actual_view(&exact)));
        assert_eq!(current["optimalActionMask"], 7);
        assert_eq!(current["kit"], "blue");
        assert_eq!(current["uses"], uses);
        assert_eq!(current["pieces"], uses * 10);
        assert_eq!(current["status"], "use_certified");
        assert_eq!(guided.current_request, Some((560, stock, limit)));
        assert_eq!(guided.current_root.as_ref().unwrap().mask, 7);
        assert_eq!(guided.current_choice.as_ref().unwrap().uses(), uses);
    }
}

#[test]
fn current_small_infeasible_and_terminal_keep_exact_fallback() {
    for (sid, stock, mask, uses, status) in [
        (560, [10, 0, 0], 1, 1, "use_certified"),
        (598, [0, 10, 10], 6, 1, "use_certified"),
        (560, [9, 9, 9], 0, 0, "preserve"),
        (TERMINAL, [200, 100, 50], 0, 0, "complete"),
    ] {
        let mut plain = current_guidance_engine();
        let exact = plain.get(sid, stock.map(|pieces| pieces / 10), true).unwrap();
        let mut current_engine = current_guidance_engine();
        let current = current_engine.current(sid, stock, 100).unwrap();
        assert_eq!(current["value"], json!(plain.actual_view(&exact)));
        assert_eq!(current["optimalActionMask"], mask);
        assert_eq!(current["uses"], uses);
        assert_eq!(current["status"], status);
        assert!(current_engine.primary.is_empty());
        assert!(current_engine.arena.is_none());
    }
}
