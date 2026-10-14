import type { Json, WorkspaceDocument } from "../../personal-data/src/contracts";
import type { CertifiedAccountPort } from "../certifiedUi/accountSession";
import { utf8Bytes, type WorkspaceItemCodec } from "./workspaceItem";

/**
 * Certified-engine workspace item (versioned like `calculator-input`):
 *   { type: "certified-session", version: 1, session: <certified session storage JSON> }
 * `session` holds exactly what the engine stores for a guest (a settled session or its
 * pending-correction envelope). Reads go through the engine's restore validation; a failing
 * item is reported as unreadable and is never applied. Other versions are preserved verbatim.
 */
export const CERTIFIED_SESSION_ITEM_TYPE = "certified-session";
const CERTIFIED_SESSION_ITEM_VERSION = 1;

type CertifiedCodecPort = Pick<
  CertifiedAccountPort,
  "validate" | "summary" | "isEmpty" | "emptyText"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnedItem(item: Json): boolean {
  return (
    isRecord(item) &&
    item["type"] === CERTIFIED_SESSION_ITEM_TYPE &&
    item["version"] === CERTIFIED_SESSION_ITEM_VERSION
  );
}

export function createCertifiedSessionCodec(port: CertifiedCodecPort): WorkspaceItemCodec<string> {
  return {
    type: CERTIFIED_SESSION_ITEM_TYPE,
    read: (document) => {
      const item = document.items.find(isOwnedItem);
      if (item === undefined) return { status: "absent" };
      const session = isRecord(item) ? item["session"] : null;
      const text = isRecord(session) ? port.validate(JSON.stringify(session)) : null;
      return text === null ? { status: "unreadable" } : { status: "value", value: text };
    },
    write: (document: WorkspaceDocument, text: string): WorkspaceDocument => {
      const session: Json = JSON.parse(text);
      return {
        schemaVersion: 1,
        items: [
          ...document.items.filter((entry) => !isOwnedItem(entry)),
          { type: CERTIFIED_SESSION_ITEM_TYPE, version: CERTIFIED_SESSION_ITEM_VERSION, session },
        ],
        lifetimeStages: document.lifetimeStages,
      };
    },
    key: (text) => text,
    summary: (text) => port.summary(text),
    bytes: utf8Bytes,
    isEmpty: (text) => port.isEmpty(text),
    empty: () => port.emptyText(),
  };
}
