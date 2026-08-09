export type NavigationOrientation = "horizontal" | "vertical";

export function nextNavigationIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
  orientation: NavigationOrientation,
): number | null {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;

  const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  if (key === previousKey) return (currentIndex - 1 + itemCount) % itemCount;
  if (key === nextKey) return (currentIndex + 1) % itemCount;
  return null;
}
