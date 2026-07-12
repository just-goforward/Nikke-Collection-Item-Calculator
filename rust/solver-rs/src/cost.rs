use crate::constants::{GAIN_B, GAIN_P, GAIN_Y, STRICT_EPSILON};

#[inline]
fn ratio(consume: f64, availability: f64) -> f64 {
    if availability > 0.0 {
        consume / availability
    } else if consume > STRICT_EPSILON {
        f64::INFINITY
    } else {
        0.0
    }
}

#[inline]
fn ipow(base: f64, p: f64) -> f64 {
    let n = p as i32;
    if (n as f64) == p && (0..=8).contains(&n) {
        base.powi(n)
    } else {
        base.powf(p)
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "keeps verified floating-point operand order"
)]
pub(crate) fn availability_cost(
    vb: f64,
    vp: f64,
    vy: f64,
    sb: f64,
    sp: f64,
    sy: f64,
    hf: f64,
    np: f64,
) -> f64 {
    availability_cost_pre(
        vb,
        vp,
        vy,
        sb + hf * GAIN_B,
        sp + hf * GAIN_P,
        sy + hf * GAIN_Y,
        np,
        1.0 / np,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "keeps verified floating-point operand order with solve-invariant inputs"
)]
pub(crate) fn availability_cost_pre(
    vb: f64,
    vp: f64,
    vy: f64,
    availability_b: f64,
    availability_p: f64,
    availability_y: f64,
    np: f64,
    inv_np: f64,
) -> f64 {
    let rb = ratio(vb, availability_b);
    let rp = ratio(vp, availability_p);
    let ry = ratio(vy, availability_y);
    if np == f64::INFINITY {
        return rb.max(rp).max(ry);
    }
    if !np.is_finite() || np <= 0.0 {
        return f64::INFINITY;
    }
    (ipow(rb, np) + ipow(rp, np) + ipow(ry, np)).powf(inv_np)
}
