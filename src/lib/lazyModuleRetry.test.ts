import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindLegacyInputRecovery,
  lazyModuleRetryUrl,
  reloadWithLegacyInputs,
  setLegacyOutcomeRecovery,
} from "./lazyModuleRetry";

describe("failed deferred module recovery", () => {
  const origin = "https://calculator.example";
  it("recovers Chrome and Firefox network failures with a new module URL", () => {
    for (const prefix of [
      "Failed to fetch dynamically imported module: ",
      "error loading dynamically imported module: ",
    ]) {
      expect(
        lazyModuleRetryUrl(
          new TypeError(`${prefix}${origin}/assets/SuccessAttemptModal-aB_19.js?retry=1`),
          "SuccessAttemptModal",
          origin,
          2,
        ),
      ).toBe(`${origin}/assets/SuccessAttemptModal-aB_19.js?retry=2`);
    }
  });
  it.each([
    "https://unrelated.example/assets/SuccessAttemptModal-good.js",
    "https://user:password@calculator.example/assets/SuccessAttemptModal-good.js",
    "https://calculator.example/assets/RecommendationContent-good.js",
    "https://calculator.example/api/SuccessAttemptModal-good.js",
    "https://calculator.example/assets/SuccessAttemptModal-good.js#external",
  ])("refuses an untrusted failure URL: %s", (url) => {
    expect(
      lazyModuleRetryUrl(
        new TypeError(`Failed to fetch dynamically imported module: ${url}`),
        "SuccessAttemptModal",
        origin,
        1,
      ),
    ).toBeNull();
  });
  it("does not label component exceptions or missing URL as a retriable network module", () => {
    expect(
      lazyModuleRetryUrl(
        new Error(`${origin}/assets/SuccessAttemptModal-good.js`),
        "SuccessAttemptModal",
        origin,
        1,
      ),
    ).toBeNull();
    expect(
      lazyModuleRetryUrl(
        new TypeError("Cannot read properties of undefined"),
        "SuccessAttemptModal",
        origin,
        1,
      ),
    ).toBeNull();
  });
  it("stops retrying a removed deployment chunk after two explicit retries", () => {
    expect(
      lazyModuleRetryUrl(
        new TypeError(
          `Failed to fetch dynamically imported module: ${origin}/assets/SuccessAttemptModal-old.js?retry=2`,
        ),
        "SuccessAttemptModal",
        origin,
        3,
      ),
    ).toBeNull();
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid retry generation: %s",
    (generation) => {
      expect(
        lazyModuleRetryUrl(
          new TypeError(
            `Failed to fetch dynamically imported module: ${origin}/assets/SuccessAttemptModal-old.js`,
          ),
          "SuccessAttemptModal",
          origin,
          generation,
        ),
      ).toBeNull();
    },
  );
  it("refuses a native network failure whose message has no module URL", () => {
    expect(
      lazyModuleRetryUrl(
        new TypeError("Failed to fetch dynamically imported module: unavailable"),
        "SuccessAttemptModal",
        origin,
        1,
      ),
    ).toBeNull();
  });
  it("does not treat a component TypeError containing an asset URL as a network failure", () => {
    expect(
      lazyModuleRetryUrl(
        new TypeError(`Invalid component input: ${origin}/assets/SuccessAttemptModal-good.js`),
        "SuccessAttemptModal",
        origin,
        1,
      ),
    ).toBeNull();
  });
});

describe("explicit reload safety", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("denies reload while current inputs require unresolved stock correction", async () => {
    const reload = vi.fn();
    const storage = { setItem: vi.fn(), getItem: vi.fn() };
    vi.stubGlobal("window", { location: { reload } });
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("location", { pathname: "/", search: "?statsEnv=disabled", reload });
    const unbind = bindLegacyInputRecovery(() => null);
    try {
      expect(await reloadWithLegacyInputs()).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      unbind();
    }
  });
  it("reads the latest registered inputs and reloads only after exact storage confirmation", async () => {
    const reload = vi.fn();
    let raw: string | null = null;
    vi.stubGlobal("window", { location: { reload } });
    vi.stubGlobal("location", { pathname: "/", search: "?statsEnv=disabled", reload });
    vi.stubGlobal("sessionStorage", {
      setItem: (_key: string, value: string) => {
        raw = value;
      },
      getItem: () => raw,
    });
    let blue = 20;
    const unbind = bindLegacyInputRecovery(() => ({
      grade: "R",
      level: 3,
      exp: 100,
      stock: { blue, purple: 30, yellow: 40 },
    }));
    try {
      blue = 77;
      expect(reloadWithLegacyInputs()).toBe(true);
      expect(JSON.parse(raw ?? "").input.stock.blue).toBe(77);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      unbind();
    }
  });
});

describe("reload storage and registration regression", () => {
  const key = "nikke:legacy-reload-input:v1";
  const input = {
    grade: "SR" as const,
    level: 10,
    exp: 1200,
    stock: { blue: 123, purple: 24, yellow: 50 },
  };

  afterEach(() => {
    setLegacyOutcomeRecovery(null);
    vi.unstubAllGlobals();
  });

  it.each(["write", "read", "mismatch"] as const)(
    "does not reload when snapshot confirmation fails at %s",
    (failure) => {
      const reload = vi.fn();
      const storage = {
        setItem: vi.fn((_key: string, _value: string) => {
          if (failure === "write") throw new Error("storage write fixture");
        }),
        getItem: vi.fn(() => {
          if (failure === "read") throw new Error("storage read fixture");
          return "a different snapshot";
        }),
        removeItem: vi.fn(),
      };
      vi.stubGlobal("location", { pathname: "/", search: "?statsEnv=disabled", reload });
      vi.stubGlobal("sessionStorage", storage);
      const unbind = bindLegacyInputRecovery(() => input);
      try {
        expect(reloadWithLegacyInputs()).toBe(false);
        expect(storage.setItem).toHaveBeenCalledOnce();
        expect(storage.setItem.mock.calls[0]?.[0]).toBe(key);
        expect(reload).not.toHaveBeenCalled();
      } finally {
        unbind();
      }
    },
  );

  it("refuses reload when reading current inputs throws", () => {
    const reload = vi.fn();
    const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("location", { pathname: "/", search: "?statsEnv=disabled", reload });
    vi.stubGlobal("sessionStorage", storage);
    const unbind = bindLegacyInputRecovery(() => {
      throw new Error("current input reader fixture");
    });
    try {
      expect(reloadWithLegacyInputs()).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      unbind();
    }
  });

  it("an older component cleanup cannot unbind the current input reader", () => {
    const reload = vi.fn();
    let raw: string | null = null;
    vi.stubGlobal("location", { pathname: "/", search: "?statsEnv=disabled", reload });
    vi.stubGlobal("sessionStorage", {
      setItem: (_key: string, value: string) => {
        raw = value;
      },
      getItem: () => raw,
      removeItem: () => {
        raw = null;
      },
    });
    const previousReader = vi.fn(() => ({ ...input, stock: { ...input.stock, blue: 1 } }));
    const currentReader = vi.fn(() => input);
    const unbindPrevious = bindLegacyInputRecovery(previousReader);
    const unbindCurrent = bindLegacyInputRecovery(currentReader);
    try {
      unbindPrevious();
      expect(reloadWithLegacyInputs()).toBe(true);
      expect(previousReader).not.toHaveBeenCalled();
      expect(currentReader).toHaveBeenCalledOnce();
      expect(JSON.parse(raw ?? "").input).toEqual(input);
      expect(reload).toHaveBeenCalledOnce();
      unbindCurrent();
      expect(reloadWithLegacyInputs()).toBe(false);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      unbindPrevious();
      unbindCurrent();
    }
  });

  it("reloads an unresolved outcome as pending without reading pre-use inputs", () => {
    const reload = vi.fn();
    let raw: string | null = null;
    vi.stubGlobal("location", { pathname: "/", search: "?statsEnv=disabled", reload });
    vi.stubGlobal("sessionStorage", {
      setItem: (_key: string, value: string) => {
        raw = value;
      },
      getItem: () => raw,
      removeItem: () => {
        raw = null;
      },
    });
    const reader = vi.fn(() => input);
    const unbind = bindLegacyInputRecovery(reader);
    try {
      expect(setLegacyOutcomeRecovery("pending")).toBe(true);
      expect(reloadWithLegacyInputs()).toBe(true);
      expect(reader).not.toHaveBeenCalled();
      expect(JSON.parse(raw ?? "")).toMatchObject({
        schema: 1,
        revision: "legacy-input-v1",
        url: "/?statsEnv=disabled",
        input: "pending",
      });
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      unbind();
    }
  });
});
