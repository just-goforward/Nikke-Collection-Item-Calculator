import type {
  BrowserRegistry,
  FontCheck,
  RegistryKey,
  RequestedTarget,
} from "./modal-contrast-types";

// Serialized independently by page.evaluate; only type imports are used here.
export function installStyleReaders(key: RegistryKey) {
  const scope = window;
  if (scope[key]) throw new Error("Modal diagnostic registry key collision");
  const helpers: BrowserRegistry["helpers"] = {};
  scope[key] = {
    document,
    timeOrigin: performance.timeOrigin,
    url: location.href,
    installed: false,
    helpers,
  };
  const properties = [
    "color",
    "background-color",
    "background-image",
    "opacity",
    "filter",
    "backdrop-filter",
    "-webkit-backdrop-filter",
    "mix-blend-mode",
    "isolation",
    "transform",
    "visibility",
    "display",
    "font",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-stretch",
    "font-variation-settings",
    "line-height",
    "letter-spacing",
    "-webkit-text-fill-color",
    "-webkit-text-stroke-color",
    "-webkit-text-stroke-width",
  ];
  const identify = (element: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const siblings = node.parentElement ? Array.from(node.parentElement.children) : [];
      parts.unshift(
        node.parentElement
          ? `${node.tagName.toLowerCase()}:nth-child(${siblings.indexOf(node) + 1})`
          : node.tagName.toLowerCase(),
      );
      if (node.id) {
        parts[0] = `#${CSS.escape(node.id)}`;
        break;
      }
    }
    return parts.join(" > ");
  };
  const numeric = (value: unknown) =>
    typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
  const animationEvidence = (animation: Animation) => {
    const timing = animation.effect?.getComputedTiming();
    return {
      id: animation.id,
      kind: animation.constructor.name,
      name: "animationName" in animation ? String(animation.animationName) : null,
      property: "transitionProperty" in animation ? String(animation.transitionProperty) : null,
      playState: animation.playState,
      pending: animation.pending,
      currentTime: numeric(animation.currentTime),
      startTime: numeric(animation.startTime),
      playbackRate: animation.playbackRate,
      timing: timing
        ? Object.fromEntries(Object.entries(timing).map(([name, value]) => [name, numeric(value)]))
        : null,
    };
  };
  helpers.identify = identify;
  helpers.element = (element) => {
    const css = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      selector: identify(element),
      className: element.getAttribute("class"),
      computed: Object.fromEntries(properties.map((name) => [name, css.getPropertyValue(name)])),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      animations: element.getAnimations({ subtree: false }).map(animationEvidence),
    };
  };
}

export function installFontReaders(key: RegistryKey) {
  const registry = window[key];
  if (!registry || registry.document !== document) throw new Error("Diagnostic document changed");
  const check = ({ key: targetKey, element }: RequestedTarget): FontCheck => {
    if (!element) return { key: targetKey, specification: null, available: null };
    const css = getComputedStyle(element);
    const specification = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    try {
      return {
        key: targetKey,
        specification,
        available: document.fonts.check(specification, element.textContent ?? ""),
      };
    } catch {
      return {
        key: targetKey,
        specification,
        available: null,
        error: "document.fonts.check failed",
      };
    }
  };
  registry.helpers.fonts = (targets) => ({
    status: document.fonts.status,
    faces: Array.from(document.fonts, (font) => ({
      family: font.family,
      style: font.style,
      weight: font.weight,
      stretch: font.stretch,
      status: font.status,
    })),
    checks: targets.map(check),
  });
}
