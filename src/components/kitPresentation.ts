import type { MessageKey } from "../i18n/messages.ko";
import type { Kit } from "../types";
import type { ResultKit } from "../ui-types";

export const KIT_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.blue",
  purple: "kit.purple",
  yellow: "kit.yellow",
};

export const KIT_PANEL_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.bluePanel",
  purple: "kit.purplePanel",
  yellow: "kit.yellowPanel",
};

export const RESULT_KIT_KEYS: Record<ResultKit, MessageKey> = {
  ...KIT_LABEL_KEYS,
  convert: "common.convertToSr",
};

export const kitDotClass: Record<Kit, string> = {
  blue: "bg-blue-kit",
  purple: "bg-purple-kit",
  yellow: "bg-yellow-kit",
};

export const resultKitDotClass: Record<ResultKit, string> = {
  ...kitDotClass,
  convert: "bg-primary",
};
