//! Adapted from certified-boundary-v1's accounted allocator. The dynamic
//! ceiling includes transient Rust allocations; host payload is subtracted by
//! the ABI before each command. Linear memory has a separate linker maximum.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static LIMIT: AtomicUsize = AtomicUsize::new(192 * 1024 * 1024);
static DENIED: AtomicBool = AtomicBool::new(false);
struct Accounted;
unsafe impl GlobalAlloc for Accounted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let old = LIVE.fetch_add(layout.size(), Relaxed);
        if old.saturating_add(layout.size()) > LIMIT.load(Relaxed) {
            LIVE.fetch_sub(layout.size(), Relaxed);
            DENIED.store(true, Relaxed);
            return std::ptr::null_mut();
        }
        let ptr = System.alloc(layout);
        if ptr.is_null() {
            LIVE.fetch_sub(layout.size(), Relaxed);
            DENIED.store(true, Relaxed);
        } else {
            PEAK.fetch_max(old + layout.size(), Relaxed);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        LIVE.fetch_sub(layout.size(), Relaxed);
    }
}
#[global_allocator]
static ALLOCATOR: Accounted = Accounted;
#[no_mangle]
pub extern "C" fn certified_heap_live() -> usize {
    LIVE.load(Relaxed)
}
#[no_mangle]
pub extern "C" fn certified_heap_peak() -> usize {
    PEAK.load(Relaxed)
}
#[no_mangle]
pub extern "C" fn certified_allocation_denied() -> bool {
    DENIED.load(Relaxed)
}
#[no_mangle]
pub extern "C" fn certified_heap_limit(bytes: usize) {
    LIMIT.store(bytes.min(192 * 1024 * 1024), Relaxed);
}
pub fn can_admit(bytes: usize) -> bool {
    LIVE.load(Relaxed).saturating_add(bytes) <= LIMIT.load(Relaxed)
}

pub(super) fn restore_handled_denial(prior: bool) {
    if !prior { DENIED.store(false, Relaxed); }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
pub(super) mod optional_reserve_probe {
    use super::*;
    use std::cell::Cell;
    thread_local! {
        static COUNTDOWN: Cell<usize> = const { Cell::new(0) };
        static OBSERVED_DENIAL: Cell<bool> = const { Cell::new(false) };
    }
    pub(crate) fn run<T>(reserve: impl FnOnce() -> T) -> T {
        let n = COUNTDOWN.get();
        if n == 0 { return reserve(); }
        COUNTDOWN.set(n-1);
        if n != 1 { return reserve(); }
        let old = LIMIT.swap(0, Relaxed);
        let result = reserve(); // real accounted allocation, not CapacityOverflow
        LIMIT.store(old, Relaxed);
        OBSERVED_DENIAL.set(certified_allocation_denied());
        result
    }
    pub(crate) fn deny<T>(nth: usize, body: impl FnOnce() -> T) -> T {
        assert!(!certified_allocation_denied());
        COUNTDOWN.set(nth); OBSERVED_DENIAL.set(false);
        let result = body();
        assert_eq!(COUNTDOWN.get(), 0); assert!(OBSERVED_DENIAL.get());
        assert!(!certified_allocation_denied(), "handled denial leaked");
        result
    }
    pub(crate) fn isolated(body: impl FnOnce()) {
        const KEY: &str = "H14_OPTIONAL_DENIAL_TEST_CHILD";
        if std::env::var_os(KEY).is_some() { body(); return; }
        let thread = std::thread::current();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact",thread.name().unwrap(),"--test-threads=1"])
            .env(KEY,"1").output().unwrap();
        assert!(child.status.success() && String::from_utf8_lossy(&child.stdout).contains("1 passed"),
            "{}\n{}",String::from_utf8_lossy(&child.stdout),String::from_utf8_lossy(&child.stderr));
    }
}

// Single-threaded request owner only: a known fallible allocation failed and
// its bounded retry has now completed. Never clear a pre-existing denial or
// an unsuccessful retry, and never reset LIVE, PEAK or the host-adjusted LIMIT.
pub(super) fn finish_fallible_retry<T,E>(previously_denied:bool,result:Result<T,E>)->Result<T,E> {
    finish_retry(&DENIED,previously_denied,result)
}
fn finish_retry<T,E>(denied:&AtomicBool,previously_denied:bool,result:Result<T,E>)->Result<T,E> {
    if !previously_denied&&result.is_ok() {denied.store(false,Relaxed);}
    result
}
#[no_mangle]
pub extern "C" fn certified_reset_heap_peak() {
    PEAK.store(LIVE.load(Relaxed), Relaxed);
    DENIED.store(false, Relaxed);
    LIMIT.store(192 * 1024 * 1024, Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallible_retry_restores_only_new_successfully_handled_denial() {
        // Local state avoids changing the allocator used by the test harness.
        // The helper receives no access to the heap ceiling or peak counters.
        for prior in [false,true] {
            for succeeds in [false,true] {
                let denied=AtomicBool::new(prior);
                let before=denied.load(Relaxed);
                denied.store(true,Relaxed); // The first fallible allocation.
                let outcome:Result<usize,&str>=if succeeds {Ok(17)} else {Err("refused")};
                assert_eq!(finish_retry(&denied,before,outcome),outcome);
                assert_eq!(denied.load(Relaxed),prior||!succeeds);
            }
        }
        // A non-allocation error with no denial must not invent one either.
        let denied=AtomicBool::new(false);
        assert_eq!(finish_retry(&denied,false,Err::<(),_>("capacity")),Err("capacity"));
        assert!(!denied.load(Relaxed));
    }
}
