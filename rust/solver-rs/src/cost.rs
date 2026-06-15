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
    let rb = ratio(vb, sb + hf * GAIN_B);
    let rp = ratio(vp, sp + hf * GAIN_P);
    let ry = ratio(vy, sy + hf * GAIN_Y);
    if np == f64::INFINITY {
        return rb.max(rp).max(ry);
    }
    if !np.is_finite() || np <= 0.0 {
        return f64::INFINITY;
    }
    (ipow(rb, np) + ipow(rp, np) + ipow(ry, np)).powf(1.0 / np)
}
