import type { TurnstileApi } from "./turnstileTokenProvider";

const SCRIPT_SELECTOR = 'script[data-nikke-turnstile-loader="true"]';
const LOAD_TIMEOUT_MS = 10_000;

let apiPromise: Promise<TurnstileApi> | null = null;

function createScriptPromise(): Promise<TurnstileApi> {
  return new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
    const script = existing ?? document.createElement("script");
    const ownsScript = existing === null;
    let settled = false;

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ownsScript) script.remove();
      reject(error);
    };
    const handleLoad = () => {
      if (!window.turnstile) {
        fail(new Error("Turnstile script loaded without an API."));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(window.turnstile);
    };
    const handleError = () => fail(new Error("Turnstile script failed."));
    const timeoutId = globalThis.setTimeout(
      () => fail(new Error("Turnstile script timed out.")),
      LOAD_TIMEOUT_MS,
    );

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    if (ownsScript) {
      script.setAttribute("data-nikke-turnstile-loader", "true");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  });
}

export async function loadTurnstileScriptApi(): Promise<TurnstileApi> {
  if (window.turnstile) return window.turnstile;
  apiPromise ??= createScriptPromise();
  const loading = apiPromise;
  try {
    return await loading;
  } catch (error) {
    if (apiPromise === loading) apiPromise = null;
    throw error;
  }
}
