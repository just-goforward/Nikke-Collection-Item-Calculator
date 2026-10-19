import { readV10Evidence } from "./evidence.ts";

export function loadIndependentApprovedPanel(
  root: string,
  anchor: string,
  engineBuildHash: string,
) {
  return readV10Evidence(root, anchor, engineBuildHash).panel;
}
