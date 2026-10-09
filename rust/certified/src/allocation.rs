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
pub extern "C" fn certified_heap_live() -> usize { LIVE.load(Relaxed) }
#[no_mangle]
pub extern "C" fn certified_heap_peak() -> usize { PEAK.load(Relaxed) }
#[no_mangle]
pub extern "C" fn certified_allocation_denied() -> bool { DENIED.load(Relaxed) }
#[no_mangle]
pub extern "C" fn certified_heap_limit(bytes: usize) { LIMIT.store(bytes.min(192 * 1024 * 1024), Relaxed); }
pub fn can_admit(bytes: usize) -> bool { LIVE.load(Relaxed).saturating_add(bytes) <= LIMIT.load(Relaxed) }
#[no_mangle]
pub extern "C" fn certified_reset_heap_peak() {
    PEAK.store(LIVE.load(Relaxed),Relaxed);
    DENIED.store(false,Relaxed);
    LIMIT.store(192*1024*1024,Relaxed);
}
