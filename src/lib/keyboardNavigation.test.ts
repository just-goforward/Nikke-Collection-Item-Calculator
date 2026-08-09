import { describe, expect, it } from "vitest";

import { nextNavigationIndex } from "./keyboardNavigation";

describe("nextNavigationIndex", () => {
  it("wraps horizontal navigation and handles boundaries", () => {
    expect(nextNavigationIndex("ArrowLeft", 0, 3, "horizontal")).toBe(2);
    expect(nextNavigationIndex("ArrowRight", 2, 3, "horizontal")).toBe(0);
    expect(nextNavigationIndex("Home", 2, 3, "horizontal")).toBe(0);
    expect(nextNavigationIndex("End", 0, 3, "horizontal")).toBe(2);
  });

  it("uses vertical arrow keys without consuming unrelated keys", () => {
    expect(nextNavigationIndex("ArrowUp", 0, 3, "vertical")).toBe(2);
    expect(nextNavigationIndex("ArrowDown", 2, 3, "vertical")).toBe(0);
    expect(nextNavigationIndex("ArrowRight", 1, 3, "vertical")).toBeNull();
    expect(nextNavigationIndex("Enter", 1, 3, "horizontal")).toBeNull();
  });
});
