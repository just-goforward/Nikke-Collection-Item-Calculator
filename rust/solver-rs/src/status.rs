pub(crate) const STATUS_OK: i32 = 0;
pub(crate) const STATUS_BUDGET_EXCEEDED: i32 = 1;
pub(crate) const STATUS_MEMO_FULL: i32 = 2;
pub(crate) const STATUS_INVALID_INPUT: i32 = 3;

pub(crate) static mut LAST_STATUS: i32 = STATUS_OK;
pub(crate) static mut NODE_BUDGET: u32 = 0;
pub(crate) static mut NODE_COUNT: u32 = 0;

#[inline]
pub(crate) unsafe fn reset_status() {
    LAST_STATUS = STATUS_OK;
    NODE_COUNT = 0;
}

#[inline]
pub(crate) unsafe fn status_ok() -> bool {
    LAST_STATUS == STATUS_OK
}

#[inline]
pub(crate) unsafe fn tick_node() -> bool {
    if LAST_STATUS != STATUS_OK {
        return false;
    }
    if NODE_BUDGET == 0 {
        return true;
    }
    NODE_COUNT = NODE_COUNT.saturating_add(1);
    if NODE_COUNT > NODE_BUDGET {
        LAST_STATUS = STATUS_BUDGET_EXCEEDED;
        return false;
    }
    true
}
