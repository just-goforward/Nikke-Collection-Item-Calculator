import { useSyncExternalStore } from "react";

const MOBILE_LAYOUT_QUERY = "(max-width: 660px)";

function subscribe(onStoreChange: () => void) {
  const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function getSnapshot() {
  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

export function useMobileLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
