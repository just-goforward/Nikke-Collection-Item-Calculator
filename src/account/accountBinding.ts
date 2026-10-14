import type { CertifiedAccountDeps, CertifiedAccountPort } from "../certifiedUi/accountSession";
import type { CalculatorInput } from "./workspaceDocument";

/** Shell wiring shared by both engines. */
type ShellBinding = {
  /** Calculator inputs are read-only while true (account check, pending switch, stale tab). */
  onLockChange: (locked: boolean) => void;
};

/** Production engine: the calculator inputs are the workspace item. */
export type CalculatorInputBinding = ShellBinding & {
  kind: "calculator-input";
  input: CalculatorInput;
  /** While the calculator is busy, server/guest inputs are applied once it is idle again. */
  inputLocked: boolean;
  onApplyInput: (input: CalculatorInput) => void;
  /** Runs after the shown inputs switched between account and guest data. */
  onSwitched?: () => void;
};

/** Certified engine: the certified session is the item; its guest copy stays in its own key. */
export type CertifiedSessionBinding = ShellBinding & {
  kind: "certified-session";
  /** The certified engine's session store; the account port is only created here, when enabled. */
  deps: CertifiedAccountDeps;
  createPort: (deps: () => CertifiedAccountDeps) => CertifiedAccountPort;
  /** Changes identity whenever the certified session changes. */
  changeToken: object;
  inputLocked: boolean;
  /** Runs after the shown session switched between account and guest data. */
  onSwitched?: () => void;
};

/** What an engine's shell passes to the account slot. */
export type AccountControlProps = CalculatorInputBinding | CertifiedSessionBinding;

export type AccountEntryProps = AccountControlProps & {
  /** Set by the slot when the bound passed before the chunk loaded: inputs are released. */
  bootFellBack: { readonly current: boolean };
};
