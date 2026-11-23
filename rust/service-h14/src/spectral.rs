//! Request-local scalar-operation ledger and mixed-radix Fourier primitives.
//! Roots are supplied only after the caller's interval-radius certification.
use super::Result;

#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Complex { pub re: f64, pub im: f64 }
impl Complex {
    pub const ZERO: Self = Self { re: 0.0, im: 0.0 };
    #[inline]
    pub(super) fn times(self, b: Self) -> Self {
        Self { re: self.re*b.re-self.im*b.im, im: self.re*b.im+self.im*b.re }
    }
    pub fn conjugate(self) -> Self { Self { re: self.re, im: -self.im } }
}

#[derive(Clone, Copy)]
#[repr(usize)]
pub(crate) enum Category { Roots, Forward, Powers, Filters, Fold, Inverse, Conversion, Physical }

#[derive(Default)]
pub(crate) struct Ledger {
    pub scalar: [u64; 8],
    pub total: u64,
}
impl Ledger {
    // Authorized v3 unit: ceil(total performed numeric primitives / 8).
    // Raw counters include the host debit; the old Q63 pair unit is unrelated.
    pub fn charge(&mut self, kind: Category, amount: u64) -> Result<()> {
        let total = self.total.checked_add(amount).ok_or("joint_source_work_limit")?;
        if total > 1_600_000_000 { return Err("joint_source_work_limit"); }
        self.total = total;
        self.scalar[kind as usize] += amount;
        Ok(())
    }
    pub fn mac_equivalent(&self) -> u64 { self.total.div_ceil(8) }
    pub fn multiply(&mut self, a: Complex, b: Complex, kind: Category) -> Result<Complex> {
        self.charge(kind, 6)?;
        Ok(a.times(b))
    }
    pub fn accumulate(&mut self, a: &mut Complex, b: Complex, kind: Category) -> Result<()> {
        self.charge(kind, 2)?;
        a.re += b.re;
        a.im += b.im;
        Ok(())
    }
    #[cfg(test)]
    pub fn power(&mut self, mut a: Complex, mut n: usize) -> Result<Complex> {
        if n == 0 { return Ok(Complex { re: 1.0, im: 0.0 }); }
        let mut result = None;
        while n != 0 {
            self.charge(Category::Powers, 2)?;
            if n & 1 != 0 {
                result = Some(match result {
                    None => a,
                    Some(value) => self.multiply(value, a, Category::Powers)?,
                });
            }
            n >>= 1;
            if n != 0 { a = self.multiply(a, a, Category::Powers)?; }
        }
        Ok(result.unwrap())
    }
}

/// Unnormalized DIT transform. `roots[k]` is exp(-2*pi*i*k/n).
/// Stages combine disjoint recursive input subsets. Shared radix3/5 real
/// butterflies have inner error <8u(1+t), and one certified outside twiddle.
/// This fits the generic radix-plus-twiddle certificate without larger bounds.
pub(crate) fn transform(input: &[Complex], output: &mut [Complex], roots: &[Complex],
    inverse: bool, ledger: &mut Ledger, kind: Category) -> Result<()> {
    let n = input.len();
    if n == 0 || n > 300 || output.len() != n || roots.len() != n {
        return Err("joint_source_contract");
    }
    fn recurse(input: &[Complex], offset: usize, stride: usize, out: &mut [Complex],
        roots: &[Complex], inverse: bool, ledger: &mut Ledger, kind: Category, values: &mut [Complex; 300]) -> Result<()> {
        let n = out.len();
        if n == 1 { out[0] = input[offset]; return Ok(()); }
        let radix = [2, 3, 5].into_iter().find(|r| n % r == 0).ok_or("joint_source_contract")?;
        let m = n / radix;
        for j in 0..radix {
            recurse(input, offset + j * stride, stride * radix,
                &mut out[j * m..(j + 1) * m], roots, inverse, ledger, kind, values)?;
        }
        // Children are finished before the parent butterfly needs scratch.
        values[..n].copy_from_slice(out);
        // All outside twiddles are zero-indexed precisely in column zero.
        // Reserve identical index, multiply and butterfly costs per node.
        let cost = match radix {
            2 => 1 + 5*m + 6*(m-1),
            3 => 2 + 19*m + 12*(m-1),
            5 => 3 + 53*m + 24*(m-1),
            _ => unreachable!(),
        };
        ledger.charge(kind,cost as u64)?;
        let root_stride = roots.len() / n;
        if radix == 2 {
            for k in 0..m {
                let index = k * root_stride;
                let root = if inverse { roots[index].conjugate() } else { roots[index] };
                let b = if index == 0 { values[m + k] }
                    else { values[m + k].times(root) };
                let a = values[k];
                out[k] = Complex { re: a.re + b.re, im: a.im + b.im };
                out[m + k] = Complex { re: a.re - b.re, im: a.im - b.im };
            }
            return Ok(());
        }
        let radix_stride = roots.len() / radix;
        let c1 = if inverse { roots[radix_stride].conjugate() } else { roots[radix_stride] };
        let c2 = if radix == 5 {
            if inverse { roots[2 * radix_stride].conjugate() } else { roots[2 * radix_stride] }
        } else { Complex::ZERO };
        for k in 0..m {
            let mut b = [Complex::ZERO; 5];
            b[0] = values[k];
            let exponent = k * root_stride;
            for j in 1..radix {
                // j<radix and k<n/radix imply this exponent is <roots.len().
                // No modulo or repeated j*k*root_stride construction.
                let index = j * exponent;
                let root = if inverse { roots[index].conjugate() } else { roots[index] };
                b[j] = if index == 0 { values[j*m+k] }
                    else { values[j*m+k].times(root) };
            }
            if radix == 3 {
                let s = Complex { re:b[1].re+b[2].re, im:b[1].im+b[2].im };
                let d = Complex { re:b[1].re-b[2].re, im:b[1].im-b[2].im };
                out[k] = Complex { re:b[0].re+s.re, im:b[0].im+s.im };
                let h = Complex { re:b[0].re-0.5*s.re, im:b[0].im-0.5*s.im };
                let t = Complex { re:c1.im*d.re, im:c1.im*d.im };
                out[m+k] = Complex { re:h.re-t.im, im:h.im+t.re };
                out[2*m+k] = Complex { re:h.re+t.im, im:h.im-t.re };
            } else {
                // c/s components come from the SAME certified root pairs.
                // Each cosine path has <=5 rounded operations; sine <=4.
                // Their combined error is <7u(1+t), below the generic radix
                // bound. The outside twiddle above is accounted separately.
                let s1 = Complex { re:b[1].re+b[4].re, im:b[1].im+b[4].im };
                let d1 = Complex { re:b[1].re-b[4].re, im:b[1].im-b[4].im };
                let s2 = Complex { re:b[2].re+b[3].re, im:b[2].im+b[3].im };
                let d2 = Complex { re:b[2].re-b[3].re, im:b[2].im-b[3].im };
                out[k] = Complex { re:(b[0].re+s1.re)+s2.re, im:(b[0].im+s1.im)+s2.im };
                let h1 = Complex { re:(b[0].re+c1.re*s1.re)+c2.re*s2.re, im:(b[0].im+c1.re*s1.im)+c2.re*s2.im };
                let h2 = Complex { re:(b[0].re+c2.re*s1.re)+c1.re*s2.re, im:(b[0].im+c2.re*s1.im)+c1.re*s2.im };
                let t1 = Complex { re:c1.im*d1.re+c2.im*d2.re, im:c1.im*d1.im+c2.im*d2.im };
                let t2 = Complex { re:c2.im*d1.re-c1.im*d2.re, im:c2.im*d1.im-c1.im*d2.im };
                out[m+k] = Complex { re:h1.re-t1.im, im:h1.im+t1.re };
                out[4*m+k] = Complex { re:h1.re+t1.im, im:h1.im-t1.re };
                out[2*m+k] = Complex { re:h2.re-t2.im, im:h2.im+t2.re };
                out[3*m+k] = Complex { re:h2.re+t2.im, im:h2.im-t2.re };
            }
        }
        Ok(())
    }
    recurse(input, 0, 1, output, roots, inverse, ledger, kind, &mut [Complex::ZERO; 300])
}

pub(crate) const RAW: [usize; 3] = [300, 120, 80];

/// Compile exponent arithmetic once, rather than once per raw frequency.
pub(crate) const NO_POWER: usize = usize::MAX;
const POWER_NODES: usize = 1 + 28 * usize::BITS as usize;
#[derive(Clone, Copy, Default)]
pub(crate) struct PowerStep { left: u16, right: u16 }
pub(crate) struct PowerBuilder {
    exponents: [usize; POWER_NODES], steps: [PowerStep; POWER_NODES], len: usize,
    pub outputs: [usize; 14],
}
impl PowerBuilder {
    pub fn new() -> Self {
        Self { exponents: [0; POWER_NODES], steps: [PowerStep { left: 0, right: 0 }; POWER_NODES],
            len: 1, outputs: [NO_POWER; 14] }
    }
    pub fn steps(&self) -> &[PowerStep] { &self.steps[..self.len] }
    pub fn compile(&mut self, targets: &[usize], ledger: &mut Ledger, check: impl Fn() -> Result<()>) -> Result<()> {
        if targets.len() > 14 { return Err("joint_source_contract"); }
        check()?;
        self.len = 1; self.exponents[0] = 1; self.outputs.fill(NO_POWER);
        // Ascending targets expose reusable sums. Targets5,6,11 require five
        // products, instead of three independent binary exponentiations.
        let mut sorted = [0usize; 14];
        sorted[..targets.len()].copy_from_slice(targets);
        for i in 1..targets.len() {
            let mut j = i;
            while j > 0 {
                ledger.charge(Category::Powers, 1)?;
                if sorted[j-1] <= sorted[j] { break; }
                sorted.swap(j-1,j); j -= 1;
            }
        }
        for &n in &sorted[..targets.len()] { self.node(n, ledger, &check)?; }
        for (i, &n) in targets.iter().enumerate() { self.outputs[i] = self.node(n, ledger, &check)?; }
        Ok(())
    }
    fn node(&mut self, n: usize, ledger: &mut Ledger, check: &impl Fn() -> Result<()>) -> Result<usize> {
        check()?;
        if n == 0 { return Ok(NO_POWER); }
        for i in 0..self.len {
            ledger.charge(Category::Powers, 1)?;
            if self.exponents[i] == n { return Ok(i); }
        }
        let mut pair = None;
        'sum: for a in (0..self.len).rev() {
            // Checkpoint modulo and candidate-exponent bound comparison.
            // The subtraction and inner equality have separate debits below.
            ledger.charge(Category::Powers, 2)?;
            if a % 64 == 0 { check()?; }
            if self.exponents[a] >= n { continue; }
            ledger.charge(Category::Powers, 1)?;
            let remainder = n - self.exponents[a];
            for b in (0..=a).rev() {
                ledger.charge(Category::Powers, 1)?;
                if self.exponents[b] == remainder { pair = Some((a,b)); break 'sum; }
            }
        }
        let (left,right) = match pair {
            Some(pair) => pair,
            None => {
                ledger.charge(Category::Powers, 2)?;
                let half = n / 2;
                (self.node(half,ledger,check)?,self.node(n-half,ledger,check)?)
            }
        };
        if self.len == POWER_NODES { return Err("joint_source_work_limit"); }
        ledger.charge(Category::Powers, 3)?;
        let index = self.len;
        self.steps[index] = PowerStep { left:left as u16,right:right as u16 };
        self.exponents[index] = n; self.len += 1;
        Ok(index)
    }
}
#[cfg(test)]
pub(crate) fn evaluate_powers(steps: &[PowerStep], base: Complex, values: &mut [Complex], ledger: &mut Ledger) -> Result<()> {
    if values.len() < steps.len().max(1) { return Err("joint_source_contract"); }
    // When a graph does not fit, debit only the performed prefix and leave
    // subsequent slots untouched, as required by work-limit diagnostics.
    if ledger.charge(Category::Powers, 6 * steps.len().saturating_sub(1) as u64).is_err() {
        values[0] = base;
        for (i, step) in steps.iter().enumerate().skip(1) {
            values[i] = ledger.multiply(values[step.left as usize], values[step.right as usize], Category::Powers)?;
        }
        return Ok(());
    }
    evaluate_prepaid(steps, base, values);
    Ok(())
}
// One multiply (six scalar primitives) per non-base node, reserved by caller.
pub(super) fn evaluate_prepaid(steps: &[PowerStep], base: Complex, values: &mut [Complex]) {
    values[0] = base;
    for (i,step) in steps.iter().enumerate().skip(1) {
        values[i] = values[step.left as usize].times(values[step.right as usize]);
    }
}
pub(crate) const HALF: usize = 151 * 120 * 80;
pub(crate) const UNIT: [usize; 3] = [30, 12, 8];
pub(crate) const SMALL: usize = 30 * 12 * 8;

/// A sparse axis uses at most five terms, hence no more error than one
/// generic radix-five stage. All nonzero inputs are disjoint grid cells.
fn sparse_axis(input: &[Complex], output: &mut [Complex], roots: &[Complex],
    ledger: &mut Ledger) -> Result<()> {
    let mut indices = [0usize; 5];
    let mut count = 0;
    for (i, value) in input.iter().enumerate() {
        if value.re == 0.0 && value.im == 0.0 { continue; }
        if count == 5 { return transform(input, output, roots, false, ledger, Category::Forward); }
        indices[count] = i;
        count += 1;
    }
    for (k, out) in output.iter_mut().enumerate() {
        let mut sum = Complex::ZERO;
        for (j, &i) in indices[..count].iter().enumerate() {
            ledger.charge(Category::Forward, 2)?; // exponent multiply and modulo
            let index = (i * k) % roots.len();
            let value = if index == 0 { input[i] }
                else { ledger.multiply(input[i], roots[index], Category::Forward)? };
            if j == 0 { sum = value; } else { ledger.accumulate(&mut sum, value, Category::Forward)?; }
        }
        *out = sum;
    }
    Ok(())
}
/// Atoms must be sorted by (z mod80,y mod120). Values retain RAW residues.
/// Only the real x-transform is full; subsequent axes retain x=0..150.
/// Initial zero z planes are never transformed along y.
pub(crate) fn forward_half(atoms: &[([u64; 3], u64)], output: &mut [Complex],
    roots: [&[Complex]; 3], ledger: &mut Ledger, check: impl Fn() -> Result<()>) -> Result<()> {
    if output.len() != HALF || roots.iter().zip(RAW).any(|(a, n)| a.len() != n) {
        return Err("joint_source_contract");
    }
    output.fill(Complex::ZERO);
    let mut input = [Complex::ZERO; 300];
    let mut transformed = [Complex::ZERO; 300];
    let mut integers = [0u64; 300];
    let mut occupied = [false; 80];
    let mut start = 0;
    let mut previous = None;
    while start < atoms.len() {
        check()?;
        let y = (atoms[start].0[1] % 120) as usize;
        let z = (atoms[start].0[2] % 80) as usize;
        let key = (z, y);
        if previous.is_some_and(|p| p >= key) { return Err("joint_source_contract"); }
        previous = Some(key);
        integers.fill(0);
        let mut end = start;
        while end < atoms.len() && ((atoms[end].0[2] % 80) as usize, (atoms[end].0[1] % 120) as usize) == key {
            ledger.charge(Category::Conversion, 1)?;
            let x = (atoms[end].0[0] % 300) as usize;
            integers[x] = integers[x].checked_add(atoms[end].1)
                .filter(|&v| v <= 1u64 << 63).ok_or("joint_source_contract")?;
            end += 1;
        }
        ledger.charge(Category::Conversion, 600)?;
        for x in 0..300 { input[x] = Complex { re: (integers[x] as f64) * (1.0 / 9_223_372_036_854_775_808.0), im: 0.0 }; }
        sparse_axis(&input, &mut transformed, roots[0], ledger)?;
        for x in 0..151 { output[(x * 120 + y) * 80 + z] = transformed[x]; }
        occupied[z] = true;
        start = end;
    }
    for z in 0..80 {
        if !occupied[z] { continue; }
        for x in 0..151 {
            check()?;
            for y in 0..120 { input[y] = output[(x * 120 + y) * 80 + z]; }
            sparse_axis(&input[..120], &mut transformed[..120], roots[1], ledger)?;
            for y in 0..120 { output[(x * 120 + y) * 80 + z] = transformed[y]; }
        }
    }
    for x in 0..151 {
        for y in 0..120 {
            check()?;
            let offset = (x * 120 + y) * 80;
            input[..80].copy_from_slice(&output[offset..offset + 80]);
            sparse_axis(&input[..80], &mut transformed[..80], roots[2], ledger)?;
            output[offset..offset + 80].copy_from_slice(&transformed[..80]);
        }
    }
    Ok(())
}

/// Inverse unnormalized small transform, followed by exactly one 1/K scale.
pub(crate) fn inverse_small(values: &mut [Complex], roots: [&[Complex]; 3],
    ledger: &mut Ledger, check: impl Fn() -> Result<()>) -> Result<()> {
    if values.len() != SMALL || roots.iter().zip(UNIT).any(|(a, n)| a.len() != n) {
        return Err("joint_source_contract");
    }
    let mut input = [Complex::ZERO; 30];
    let mut output = [Complex::ZERO; 30];
    for axis in 0..3 {
        let n = UNIT[axis];
        let stride = UNIT[axis + 1..].iter().product::<usize>();
        let blocks = SMALL / (n * stride);
        for block in 0..blocks {
            for tail in 0..stride {
                check()?;
                let base = block * n * stride + tail;
                for k in 0..n { input[k] = values[base + k * stride]; }
                transform(&input[..n], &mut output[..n], roots[axis], true, ledger, Category::Inverse)?;
                for k in 0..n { values[base + k * stride] = output[k]; }
            }
        }
    }
    ledger.charge(Category::Inverse, (2 * SMALL) as u64)?;
    for value in values { value.re /= SMALL as f64; value.im /= SMALL as f64; }
    Ok(())
}

/// One-axis block-sum filter, including stock phase. The stock residue is
/// reduced as an integer BEFORE multiplication, avoiding binary64 large-stock
/// phase loss. Bounds use ten certified roots, nine adds, division and one
/// complex multiply; no sin quotient or complex exponentiation is used.
pub(crate) fn axis_filter(roots: &[Complex], stock: u64, output: &mut [Complex],
    ledger: &mut Ledger) -> Result<()> {
    let n = roots.len();
    if !RAW.contains(&n) || output.len() != n { return Err("joint_source_contract"); }
    ledger.charge(Category::Filters, 1)?;
    let residue = (stock % n as u64) as usize;
    for k in 0..n {
        if k == 0 { output[k] = Complex { re: 1.0, im: 0.0 }; continue; }
        // These zeros follow exactly from the ten-term roots-of-unity sum;
        // using them is algebraic simplification, not numerical truncation.
        if k % (n / 10) == 0 { output[k] = Complex::ZERO; continue; }
        let mut sum = Complex { re: 1.0, im: 0.0 };
        // Nine geometric exponents and one stock-phase exponent, each
        // constructed by an integer multiply and remainder.
        ledger.charge(Category::Filters, 20)?;
        for r in 1..10 { ledger.accumulate(&mut sum, roots[(k * r) % n].conjugate(), Category::Filters)?; }
        ledger.charge(Category::Filters, 2)?;
        sum.re /= 10.0;
        sum.im /= 10.0;
        output[k] = ledger.multiply(sum, roots[(k * residue) % n], Category::Filters)?;
    }
    Ok(())
}

/// Add a raw half-frequency and its absent conjugate. The x=0 and x=150
/// planes already contain ALL their y/z conjugates, and are never doubled.
#[cfg(test)]
pub(crate) fn fold_half_mode(frequency: [usize; 3], value: Complex,
    small: &mut [Complex], ledger: &mut Ledger) -> Result<()> {
    let [x, y, z] = frequency;
    if x > 150 || y >= 120 || z >= 80 || small.len() != SMALL {
        return Err("joint_source_contract");
    }
    let index = ((x % 30) * 12 + y % 12) * 8 + z % 8;
    ledger.accumulate(&mut small[index], value, Category::Fold)?;
    if x != 0 && x != 150 {
        let negative = (((300 - x) % 30) * 12 + (120 - y) % 12) * 8 + (80 - z) % 8;
        ledger.accumulate(&mut small[negative], value.conjugate(), Category::Fold)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn block_sum_preserves_every_stock_residue_and_periodic_boundary() {
        let mut ledger = Ledger::default();
        let mut raw_roots = [Complex::ZERO; 300];
        let mut unit_roots = [Complex::ZERO; 30];
        super::super::spectral_roots::fill(&mut raw_roots, &mut ledger).unwrap();
        super::super::spectral_roots::fill(&mut unit_roots, &mut ledger).unwrap();
        for stock in 0..10u64 {
            let mut filter = [Complex::ZERO; 300];
            axis_filter(&raw_roots, stock, &mut filter, &mut ledger).unwrap();
            for gain in [0usize, 1, 9, 10, 149, 150, 289, 299] {
                let mut spectrum = [Complex::ZERO; 30];
                for k in 0..300 {
                    let value = ledger.multiply(raw_roots[(k * gain) % 300], filter[k], Category::Fold).unwrap();
                    ledger.accumulate(&mut spectrum[k % 30], value, Category::Fold).unwrap();
                }
                let mut output = [Complex::ZERO; 30];
                transform(&spectrum, &mut output, &unit_roots, true, &mut ledger, Category::Inverse).unwrap();
                let expected = ((gain + stock as usize) / 10) % 30;
                for (i, value) in output.iter().enumerate() {
                    assert!((value.re / 30.0 - if i == expected { 1.0 } else { 0.0 }).abs() < 2f64.powi(-36));
                    assert!((value.im / 30.0).abs() < 2f64.powi(-36));
                }
            }
        }
    }
    #[test]
    fn persistent_cohort_products_are_not_daily_mixtures() {
        // Equal-prior persistent cohorts each give deterministically zero or
        // ten pieces. After two days: mass1/2 at0 and20, never10.
        let mut ledger = Ledger::default();
        let mut roots = [Complex::ZERO; 300];
        super::super::spectral_roots::fill(&mut roots, &mut ledger).unwrap();
        let k = 15usize;
        let a = Complex { re: 1.0, im: 0.0 };
        let b = roots[(10 * k) % 300];
        let aa = ledger.power(a, 2).unwrap();
        let bb = ledger.power(b, 2).unwrap();
        let persistent = Complex { re: 0.5 * (aa.re + bb.re), im: 0.5 * (aa.im + bb.im) };
        let daily = ledger.power(Complex { re: 0.5 * (a.re + b.re), im: 0.5 * (a.im + b.im) }, 2).unwrap();
        assert_eq!(persistent.re, 1.0);
        assert_eq!(daily.re, 0.0);
    }
    #[test]
    fn half_fold_does_not_double_nyquist_planes() {
        let mut small = [Complex::ZERO; SMALL];
        let mut ledger = Ledger::default();
        fold_half_mode([150, 1, 1], Complex { re: 0.25, im: 0.5 }, &mut small, &mut ledger).unwrap();
        assert_eq!(small[9].re, 0.25);
        assert_eq!(ledger.total, 2);
        fold_half_mode([1, 1, 1], Complex { re: 0.25, im: 0.5 }, &mut small, &mut ledger).unwrap();
        assert_eq!(ledger.total, 6);
        assert_eq!(small[(29 * 12 + 11) * 8 + 7].im, -0.5);
    }
    #[test]
    fn mixed_radices_match_independent_direct_sum() {
        for n in [2usize, 3, 5, 8, 12, 30, 80, 120, 300] {
            let mut roots = vec![Complex::ZERO; n];
            super::super::spectral_roots::fill(&mut roots, &mut Ledger::default()).unwrap();
            let mut input = vec![Complex::ZERO; n];
            input[0].re = 0.25;
            input[1].re = 0.5;
            input[n - 1].re += 0.25;
            let mut output = vec![Complex::ZERO; n];
            transform(&input, &mut output, &roots, false, &mut Ledger::default(), Category::Forward).unwrap();
            for k in 0..n {
                let mut expected = Complex::ZERO;
                for j in 0..n {
                    expected.re += input[j].re * roots[(j * k) % n].re;
                    expected.im += input[j].re * roots[(j * k) % n].im;
                }
                assert!((output[k].re - expected.re).abs() < 2f64.powi(-40));
                assert!((output[k].im - expected.im).abs() < 2f64.powi(-40));
            }
        }
    }
    #[test]
    fn zero_plane_half_transform_preserves_joint_nyquist_phase() {
        let mut roots = [vec![Complex::ZERO; 300], vec![Complex::ZERO; 120], vec![Complex::ZERO; 80]];
        let mut ledger = Ledger::default();
        for axis in &mut roots { super::super::spectral_roots::fill(axis, &mut ledger).unwrap(); }
        let mut half = vec![Complex::ZERO; HALF];
        let atoms = [([2, 1, 1], 1u64 << 63)];
        forward_half(&atoms, &mut half, [&roots[0], &roots[1], &roots[2]], &mut ledger, || Ok(())).unwrap();
        // x=Nyquist alone is not a self-conjugate 3D frequency. y,z phase
        // remains complex and must not be doubled or replaced by its real part.
        let k = [150usize, 1, 1];
        let expected = ledger.multiply(roots[1][1], roots[2][1], Category::Physical).unwrap();
        let value = half[(k[0] * 120 + k[1]) * 80 + k[2]];
        assert!((value.re - expected.re).abs() < 2f64.powi(-38));
        assert!((value.im - expected.im).abs() < 2f64.powi(-38));
        assert!(value.im.abs() > 0.01);
    }
    #[test]
    fn radix_two_and_nyquist_are_exact() {
        let input = [Complex { re: 0.25, im: 0.0 }, Complex { re: 0.75, im: 0.0 }];
        let roots = [Complex { re: 1.0, im: 0.0 }, Complex { re: -1.0, im: 0.0 }];
        let mut out = [Complex::ZERO; 2];
        let mut ledger = Ledger::default();
        transform(&input, &mut out, &roots, false, &mut ledger, Category::Forward).unwrap();
        assert_eq!((out[0].re, out[1].re), (1.0, -0.5));
        assert_eq!(ledger.total, 6); // stride/index construction plus four adds
        let mut recovered = [Complex::ZERO; 2];
        transform(&out, &mut recovered, &roots, true, &mut ledger, Category::Inverse).unwrap();
        assert_eq!((recovered[0].re, recovered[1].re), (0.5, 1.5));
    }
    #[test]
    fn failed_charge_never_refunds_work() {
        let mut ledger = Ledger::default();
        ledger.charge(Category::Fold, 1_599_999_999).unwrap();
        assert_eq!(ledger.mac_equivalent(), 200_000_000);
        assert_eq!(ledger.charge(Category::Fold, 2), Err("joint_source_work_limit"));
        assert_eq!(ledger.total, 1_599_999_999);
        assert_eq!(ledger.scalar[Category::Fold as usize], 1_599_999_999);
    }
    #[test]
    fn twiddle_integer_work_is_charged_at_the_shared_raw_boundary() {
        let input = [Complex { re: 1.0, im: 0.0 }, Complex::ZERO];
        let roots = [Complex { re: 1.0, im: 0.0 }, Complex { re: -1.0, im: 0.0 }];
        let mut output = [Complex::ZERO; 2];
        let mut ledger = Ledger::default();
        ledger.charge(Category::Physical, 1_600_000_000 - 6).unwrap();
        transform(&input, &mut output, &roots, false, &mut ledger, Category::Forward).unwrap();
        assert_eq!(ledger.total, 1_600_000_000);
        assert_eq!(ledger.scalar[Category::Forward as usize], 6);
        assert_eq!(transform(&input, &mut output, &roots, false, &mut ledger, Category::Forward),
            Err("joint_source_work_limit"));
        assert_eq!(ledger.total, 1_600_000_000);

        // A zero-frequency singleton needs no floating arithmetic, but its
        // direct sparse twiddle construction still spends multiply/modulo.
        let mut sparse = Ledger::default();
        sparse_axis(&input, &mut output, &roots, &mut sparse).unwrap();
        assert_eq!(sparse.total, 4);
        let mut limited = Ledger::default();
        limited.charge(Category::Physical, 1_600_000_000 - 1).unwrap();
        assert_eq!(sparse_axis(&input, &mut output, &roots, &mut limited),
            Err("joint_source_work_limit"));
        assert_eq!(limited.total, 1_600_000_000 - 1);
    }
    #[test]
    fn shared_radix_three_counts_twiddle_construction_and_real_butterfly() {
        let mut roots = [Complex::ZERO; 3];
        super::super::spectral_roots::fill(&mut roots, &mut Ledger::default()).unwrap();
        let mut output = [Complex::ZERO; 3];
        let mut ledger = Ledger::default();
        transform(&[Complex::ZERO; 3], &mut output, &roots, false, &mut ledger, Category::Forward).unwrap();
        // Two stride divisions, one base exponent and two j*exponent
        // products, followed by the sixteen-real-operation butterfly.
        assert_eq!(ledger.total, 2 + 1 + 2 + 16);
    }
    #[test]
    fn shared_radices_match_complex_direct_dft_and_inverse() {
        for n in [3usize,5,15,30,80,120,300] {
            let mut roots = vec![Complex::ZERO;n];
            super::super::spectral_roots::fill(&mut roots,&mut Ledger::default()).unwrap();
            let input: Vec<_> = (0..n).map(|j| Complex {
                re: ((j%7) as f64-3.0)/16.0, im: ((j%5) as f64-2.0)/32.0,
            }).collect();
            let mut output = vec![Complex::ZERO;n];
            transform(&input,&mut output,&roots,false,&mut Ledger::default(),Category::Forward).unwrap();
            for k in 0..n {
                let mut expected = Complex::ZERO;
                for j in 0..n {
                    let root = roots[(j*k)%n];
                    expected.re += input[j].re*root.re-input[j].im*root.im;
                    expected.im += input[j].re*root.im+input[j].im*root.re;
                }
                assert!((output[k].re-expected.re).abs()<5e-11,"n={n} k={k}");
                assert!((output[k].im-expected.im).abs()<5e-11,"n={n} k={k}");
            }
            let mut recovered = vec![Complex::ZERO;n];
            transform(&output,&mut recovered,&roots,true,&mut Ledger::default(),Category::Inverse).unwrap();
            for j in 0..n {
                assert!((recovered[j].re/n as f64-input[j].re).abs()<5e-12);
                assert!((recovered[j].im/n as f64-input[j].im).abs()<5e-12);
            }
        }
    }
    #[test]
    fn shared_power_graph_reuses_actual_event_delta_powers() {
        let mut builder = PowerBuilder::new();
        let mut setup = Ledger::default();
        builder.compile(&[11,6,5],&mut setup,|| Ok(())).unwrap();
        assert_eq!(builder.steps().len(),6); // base plus five actual CMULs
        assert!(setup.total>0);
        let base = Complex { re:0.75,im:0.125 };
        let mut values = vec![Complex::ZERO;builder.steps().len()];
        let mut evaluated = Ledger::default();
        evaluate_powers(builder.steps(),base,&mut values,&mut evaluated).unwrap();
        assert_eq!(evaluated.total,30);
        for (i,n) in [11,6,5].into_iter().enumerate() {
            let mut expected = Complex { re:1.0,im:0.0 };
            for _ in 0..n {
                expected = Complex { re:expected.re*base.re-expected.im*base.im,
                    im:expected.re*base.im+expected.im*base.re };
            }
            let actual = values[builder.outputs[i]];
            assert!((actual.re-expected.re).abs()<1e-14);
            assert!((actual.im-expected.im).abs()<1e-14);
        }
        let mut limited = Ledger::default();
        limited.charge(Category::Physical,1_600_000_000-29).unwrap();
        assert_eq!(evaluate_powers(builder.steps(),base,&mut values,&mut limited),Err("joint_source_work_limit"));
        assert_eq!(limited.total,1_600_000_000-5); // four executed CMULs retained
    }
    #[test]
    fn power_setup_has_an_exact_shared_budget_boundary() {
        // Target2: initial lookup1, outer modulo/comparison2, subtraction1,
        // inner equality1, node construction3, final output lookup2 =10.
        let mut builder = PowerBuilder::new();
        let mut ledger = Ledger::default();
        ledger.charge(Category::Physical,1_600_000_000-10).unwrap();
        builder.compile(&[2],&mut ledger,|| Ok(())).unwrap();
        assert_eq!(ledger.total,1_600_000_000);
        assert_eq!(ledger.scalar[Category::Powers as usize],10);
        assert_eq!(builder.outputs[0],1);
        assert_eq!(builder.steps().len(),2);

        let mut short = Ledger::default();
        short.charge(Category::Physical,1_600_000_000-9).unwrap();
        assert_eq!(builder.compile(&[2],&mut short,|| Ok(())),Err("joint_source_work_limit"));
        assert_eq!(short.total,1_600_000_000);
        assert_eq!(short.scalar[Category::Powers as usize],9);
        assert_eq!(builder.outputs[0],NO_POWER);

        let mut before_search = Ledger::default();
        before_search.charge(Category::Physical,1_600_000_000-1).unwrap();
        let checks = std::cell::Cell::new(0);
        assert_eq!(builder.compile(&[2],&mut before_search,|| {
            checks.set(checks.get()+1); Ok(())
        }),Err("joint_source_work_limit"));
        assert_eq!(checks.get(),2); // refusal precedes the outer modulo/check
        assert_eq!(before_search.scalar[Category::Powers as usize],1);
        assert_eq!(builder.steps().len(),1);
    }
    #[test]
    fn compiled_power_zero_one_and_machine_word_boundary() {
        let mut builder = PowerBuilder::new();
        builder.compile(&[0,1,1],&mut Ledger::default(),|| Ok(())).unwrap();
        assert_eq!(&builder.outputs[..3],&[NO_POWER,0,0]);
        assert_eq!(builder.steps().len(),1);
        builder.compile(&[usize::MAX],&mut Ledger::default(),|| Ok(())).unwrap();
        assert!(builder.steps().len()<=1+2*usize::BITS as usize);
        let mut values = vec![Complex::ZERO;builder.steps().len()];
        evaluate_powers(builder.steps(),Complex { re:1.0,im:0.0 },&mut values,&mut Ledger::default()).unwrap();
        assert_eq!(values[builder.outputs[0]].re,1.0);
        assert_eq!(values[builder.outputs[0]].im,0.0);
    }
    #[test]
    fn power_planning_cancellation_preserves_performed_work() {
        let mut builder = PowerBuilder::new();
        let mut ledger = Ledger::default();
        let checks = std::cell::Cell::new(0);
        let result = builder.compile(&[usize::MAX],&mut ledger,|| {
            checks.set(checks.get()+1);
            if checks.get()==4 { Err("request_budget_exhausted") } else { Ok(()) }
        });
        assert_eq!(result,Err("request_budget_exhausted"));
        assert_eq!(checks.get(),4);
        assert!(ledger.total>0);
        assert_eq!(ledger.total,ledger.scalar[Category::Powers as usize]);
    }
    #[test]
    fn unsupported_radix_is_rejected() {
        let a = [Complex::ZERO; 7];
        let mut out = a;
        assert_eq!(transform(&a, &mut out, &a, false, &mut Ledger::default(), Category::Forward),
            Err("joint_source_contract"));
    }
}
