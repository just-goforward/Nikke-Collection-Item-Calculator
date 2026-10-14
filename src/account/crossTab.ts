/** Same-browser tab coordination. Messages carry account IDs and revisions only, never data. */
export type CrossTabMessage =
  | { type: "account"; userId: string }
  | { type: "logged-out"; userId: string }
  | { type: "deleted"; userId: string }
  | { type: "revision"; userId: string; revision: number };

export type CrossTabChannel = {
  post(message: CrossTabMessage): void;
  subscribe(listener: (message: CrossTabMessage) => void): () => void;
  close(): void;
};

const ACCOUNT_CHANNEL_NAME = "collection-kit-account-v1";
const USER_MESSAGE_TYPES = new Set(["account", "logged-out", "deleted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCrossTabMessage(value: unknown): CrossTabMessage | null {
  if (!isRecord(value)) return null;
  const { type, userId } = value;
  if (typeof type !== "string" || typeof userId !== "string") return null;
  if (type === "revision") {
    const revision = value["revision"];
    return Number.isSafeInteger(revision) && typeof revision === "number" && revision >= 0
      ? { type, userId, revision }
      : null;
  }
  if (!USER_MESSAGE_TYPES.has(type)) return null;
  return { type: type as Exclude<CrossTabMessage["type"], "revision">, userId };
}

export function createCrossTabChannel(name = ACCOUNT_CHANNEL_NAME): CrossTabChannel {
  const channel = new BroadcastChannel(name);
  return {
    post: (message) => channel.postMessage(message),
    subscribe: (listener) => {
      const handle = (event: MessageEvent) => {
        const message = parseCrossTabMessage(event.data);
        if (message) listener(message);
      };
      channel.addEventListener("message", handle);
      return () => channel.removeEventListener("message", handle);
    },
    close: () => channel.close(),
  };
}
