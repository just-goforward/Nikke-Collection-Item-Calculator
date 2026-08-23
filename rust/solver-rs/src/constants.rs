pub(crate) const STRICT_EPSILON: f64 = 1e-12;
pub(crate) const KIT_EXP: [i32; 3] = [200, 500, 1000];
pub(crate) const REQUIRED_EXP: [i32; 2] = [1000, 3000];
include!("generated_supply_forecast.rs");
pub(crate) const MAX_USES_B: i32 = 220;
pub(crate) const MAX_USES_P: i32 = 88;
pub(crate) const MAX_USES_Y: i32 = 44;
pub(crate) const LEVEL_BUCKETS: i32 = 16;
pub(crate) const EXP_BUCKETS: i32 = 30;
pub(crate) const STATE_DIV: i32 = LEVEL_BUCKETS * EXP_BUCKETS;
pub(crate) const STATE_BUCKETS: i32 = 2 * STATE_DIV;
pub(crate) const STOCK_P_DIM: i32 = MAX_USES_P + 1;
pub(crate) const STOCK_Y_DIM: i32 = MAX_USES_Y + 1;
pub(crate) const STOCK_ID_SIZE: i32 = (MAX_USES_B + 1) * STOCK_P_DIM * STOCK_Y_DIM;

#[rustfmt::skip]
const GREAT_PERCENT: [f64; 90] = [
    // R blue / purple / yellow
    17.6,20.8,24.0,27.2,40.0, 16.0,19.2,22.4,27.2,40.0, 14.4,17.6,22.4,27.2,40.0,
    55.0,65.0,75.0,85.0,100.0, 50.0,60.0,70.0,85.0,100.0, 45.0,55.0,70.0,85.0,100.0,
    100.0,100.0,100.0,100.0,100.0, 100.0,100.0,100.0,100.0,100.0, 100.0,100.0,100.0,100.0,100.0,
    // SR blue / purple / yellow
    3.6,5.9,7.8,11.3,15.0, 2.2,3.3,4.9,7.6,12.5, 1.2,2.2,3.1,4.7,10.0,
    11.0,19.8,28.7,41.3,55.0, 8.0,12.0,18.0,28.0,50.0, 5.4,9.9,14.4,21.6,45.0,
    25.0,40.0,55.0,75.0,100.0, 20.0,30.0,45.0,70.0,100.0, 15.0,27.5,40.0,60.0,100.0,
];

#[inline]
pub(crate) fn great_success_prob(grade_id: i32, kit: i32, level: i32) -> f64 {
    GREAT_PERCENT[(grade_id * 45 + kit * 15 + level) as usize] / 100.0
}
