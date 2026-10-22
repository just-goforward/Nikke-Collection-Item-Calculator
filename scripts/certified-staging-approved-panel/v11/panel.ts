import { readV11Evidence } from "./evidence.ts";

export function loadIndependentPanel(root: string, trustedAnchor: string, engineBuildHash: string) {
  return readV11Evidence(root, trustedAnchor, engineBuildHash).panel;
}
