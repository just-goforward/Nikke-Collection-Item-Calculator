import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { KIT_ORDER } from "../../shared/game";
import { KIT_LABEL_KEYS } from "../components/kitPresentation";
import { useI18n } from "../i18n/locale";
import type { AccountController } from "./accountController";
import { type AccountMessageKey, accountText } from "./accountMessages";
import type { ConflictChoice, SignedInView, WorkspaceConflict } from "./accountState";
import type { CalculatorInput } from "./workspaceDocument";

export const accountClasses = {
  trigger:
    "inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-card border border-border bg-button px-2.5 text-[11.5px] font-bold text-text-soft transition-[border-color,color] duration-[160ms] hover:border-grade-active hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-2 focus-visible:ring-offset-page disabled:cursor-wait disabled:opacity-70",
  dialog:
    "m-auto max-h-[calc(100dvh-32px)] w-[min(540px,calc(100%-24px))] overflow-y-auto rounded-card border border-border bg-surface p-5 text-text shadow-panel backdrop:bg-[rgba(9,18,28,0.48)] max-mobile:p-4",
  header: "mb-3 flex items-start justify-between gap-3",
  title: "m-0 text-[18px] font-semibold leading-[1.3] text-text-strong focus:outline-none",
  text: "m-0 text-[13px] leading-[1.55] text-text-soft",
  section: "mt-4 grid gap-2 border-t border-border pt-4",
  heading: "m-0 text-[14px] font-bold text-text-strong",
  row: "flex flex-wrap items-center gap-2",
  button:
    "inline-flex min-h-9 items-center justify-center rounded-control border border-border bg-button px-3.5 text-[12.5px] font-bold text-text-soft hover:border-grade-active hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active disabled:cursor-not-allowed disabled:opacity-60",
  primary:
    "inline-flex min-h-9 items-center justify-center rounded-control border border-action bg-action px-3.5 text-[12.5px] font-bold text-ice enabled:hover:brightness-[1.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active disabled:cursor-not-allowed disabled:opacity-60",
  danger:
    "inline-flex min-h-9 items-center justify-center rounded-control border border-danger bg-danger-soft px-3.5 text-[12.5px] font-bold text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger disabled:cursor-not-allowed disabled:opacity-60",
  warning:
    "m-0 rounded-control border border-warning bg-warning-soft px-3 py-2 text-[12.5px] font-semibold leading-[1.5] text-warning",
  choice: "flex min-h-8 items-center gap-2 text-[13px] font-semibold text-text",
  meter: "h-2 w-full",
  summary: "grid gap-1 rounded-control border border-border bg-surface-strong p-3",
  summaryList: "m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]",
} as const;

export type AccountText = (
  key: AccountMessageKey,
  params?: Record<string, string | number>,
) => string;

export function useAccountText(): AccountText {
  const { locale } = useI18n();
  return useCallback((key, params) => accountText(locale, key, params), [locale]);
}

type ModalDialogProps = {
  open: boolean;
  titleId: string;
  descriptionId?: string;
  onCancel: () => void;
  children: ReactNode;
};

/** Native modal dialog: focus is trapped by the browser, Escape cancels, focus returns on close. */
function ModalDialog({ open, titleId, descriptionId, onCancel, children }: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      dialog.close();
      const target = previous?.isConnected
        ? previous
        : document.querySelector<HTMLElement>("[data-account-trigger]");
      target?.focus();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={accountClasses.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {open ? children : null}
    </dialog>
  );
}

function bytesText(formatNumber: (value: number, digits?: number) => string, bytes: number) {
  return `${formatNumber(bytes / 1_000_000, 2)} MB`;
}

function SyncSection({
  controller,
  persistent,
  view,
}: {
  controller: AccountController;
  persistent: boolean;
  view: SignedInView;
}) {
  const text = useAccountText();
  return (
    <section className={accountClasses.section} aria-labelledby="account-sync-heading">
      <h3 id="account-sync-heading" className={accountClasses.heading}>
        {text("syncHeading")}
      </h3>
      <p className={accountClasses.text} data-testid="account-sync-status">
        {text(`sync.${view.sync}`)} · {text("syncRevision", { revision: view.revision })}
      </p>
      <div className={accountClasses.row}>
        {view.guestImport ? (
          <button
            className={accountClasses.primary}
            type="button"
            onClick={() => void controller.copyGuestInputs()}
          >
            {text("guestImportCopy")}
          </button>
        ) : null}
        {view.sync === "paused" ? (
          <button
            className={accountClasses.primary}
            type="button"
            onClick={() => void controller.resumeSync()}
          >
            {text("resolveConflict")}
          </button>
        ) : (
          <button
            className={accountClasses.button}
            type="button"
            disabled={view.sync === "saving" || view.sync === "conflict"}
            onClick={() => void controller.syncNow()}
          >
            {text("syncNow")}
          </button>
        )}
      </div>
      {persistent ? null : <p className={accountClasses.warning}>{text("deviceOnly")}</p>}
    </section>
  );
}

function StorageSection({ view }: { view: SignedInView }) {
  const text = useAccountText();
  const { formatNumber } = useI18n();
  const quota = view.quota;
  return (
    <section className={accountClasses.section} aria-labelledby="account-storage-heading">
      <h3 id="account-storage-heading" className={accountClasses.heading}>
        {text("storageHeading")}
      </h3>
      {quota ? (
        <>
          <meter
            className={accountClasses.meter}
            aria-labelledby="account-storage-heading"
            min={0}
            max={Math.max(quota.limitBytes, 1)}
            value={Math.min(quota.bytes, Math.max(quota.limitBytes, 1))}
          />
          <p className={accountClasses.text}>
            {text("storageUsage", {
              used: bytesText(formatNumber, quota.bytes),
              limit: bytesText(formatNumber, quota.limitBytes),
              percent: `${formatNumber(quota.limitBytes > 0 ? (quota.bytes / quota.limitBytes) * 100 : 0, 1)}%`,
            })}
          </p>
        </>
      ) : (
        <p className={accountClasses.text}>{text("storageUnknown")}</p>
      )}
      {view.archivingBlocked ? (
        <p className={accountClasses.warning}>{text("archivingBlocked")}</p>
      ) : null}
    </section>
  );
}

function consentStatusKey(participation: boolean | null): AccountMessageKey {
  if (participation === null) return "consentCurrentUnset";
  return participation ? "consentCurrentYes" : "consentCurrentNo";
}

function ConsentSettings({
  controller,
  view,
}: {
  controller: AccountController;
  view: SignedInView;
}) {
  const text = useAccountText();
  const current = view.consent.participation;
  const [choice, setChoice] = useState<boolean | null>(current);
  useEffect(() => setChoice(current), [current]);
  const busy = view.busy === "consent";
  return (
    <section className={accountClasses.section} aria-labelledby="account-consent-heading">
      <h3 id="account-consent-heading" className={accountClasses.heading}>
        {text("consentHeading")}
      </h3>
      <p className={accountClasses.text}>{text(consentStatusKey(current))}</p>
      <fieldset className="m-0 grid gap-1 border-0 p-0">
        <legend className={accountClasses.text}>{text("consentQuestion")}</legend>
        {[true, false].map((value) => (
          <label className={accountClasses.choice} key={String(value)}>
            <input
              type="radio"
              name="account-consent"
              checked={choice === value}
              onChange={() => setChoice(value)}
            />
            {text(value ? "consentYes" : "consentNo")}
          </label>
        ))}
      </fieldset>
      <p className={accountClasses.text}>{text("consentDetail")}</p>
      <div className={accountClasses.row}>
        <button
          className={accountClasses.button}
          type="button"
          aria-busy={busy}
          disabled={busy || choice === null || choice === current}
          onClick={() => {
            if (choice !== null) void controller.setConsent(choice);
          }}
        >
          {text("consentSave")}
        </button>
      </div>
    </section>
  );
}

function DeleteAccountDialog({
  busy,
  onCancel,
  onConfirm,
  open,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
}) {
  const text = useAccountText();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!open) setConfirmed(false);
  }, [open]);
  return (
    <ModalDialog
      open={open}
      titleId="account-delete-title"
      descriptionId="account-delete-detail"
      onCancel={onCancel}
    >
      <h2 id="account-delete-title" className={accountClasses.title}>
        {text("deleteTitle")}
      </h2>
      <p id="account-delete-detail" className={`${accountClasses.text} mt-2`}>
        {text("deleteDetail")}
      </p>
      <label className={`${accountClasses.choice} mt-3`}>
        <input
          type="checkbox"
          data-initial-focus
          checked={confirmed}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />
        {text("deleteConfirmCheck")}
      </label>
      <div className={`${accountClasses.row} mt-4 justify-end`}>
        <button className={accountClasses.button} type="button" onClick={onCancel}>
          {text("cancel")}
        </button>
        <button
          className={accountClasses.danger}
          type="button"
          aria-busy={busy}
          disabled={!confirmed || busy}
          onClick={onConfirm}
        >
          {text("deleteConfirm")}
        </button>
      </div>
    </ModalDialog>
  );
}

function SessionSections({
  controller,
  view,
}: {
  controller: AccountController;
  view: SignedInView;
}) {
  const text = useAccountText();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = view.busy !== null;
  return (
    <>
      <section className={accountClasses.section} aria-labelledby="account-data-heading">
        <h3 id="account-data-heading" className={accountClasses.heading}>
          {text("dataHeading")}
        </h3>
        <div className={accountClasses.row}>
          <button
            className={accountClasses.button}
            type="button"
            aria-busy={view.busy === "export"}
            disabled={busy}
            onClick={() => void controller.exportData()}
          >
            {text("export")}
          </button>
        </div>
      </section>
      <section className={accountClasses.section} aria-labelledby="account-sessions-heading">
        <h3 id="account-sessions-heading" className={accountClasses.heading}>
          {text("sessionsHeading")}
        </h3>
        <p className={accountClasses.text}>{text("sessionsDetail")}</p>
        <div className={accountClasses.row}>
          <button
            className={accountClasses.button}
            type="button"
            aria-busy={view.busy === "logout"}
            disabled={busy}
            onClick={() => void controller.logout()}
          >
            {text("logout")}
          </button>
          <button
            className={accountClasses.button}
            type="button"
            aria-busy={view.busy === "revoke"}
            disabled={busy}
            onClick={() => void controller.revokeAllSessions()}
          >
            {text("revokeAll")}
          </button>
        </div>
      </section>
      <section className={accountClasses.section} aria-labelledby="account-delete-heading">
        <h3 id="account-delete-heading" className={accountClasses.heading}>
          {text("deleteHeading")}
        </h3>
        <div className={accountClasses.row}>
          <button
            className={accountClasses.danger}
            type="button"
            aria-haspopup="dialog"
            disabled={busy}
            onClick={() => setDeleteOpen(true)}
          >
            {text("deleteOpen")}
          </button>
        </div>
      </section>
      <DeleteAccountDialog
        open={deleteOpen}
        busy={view.busy === "delete"}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void controller.deleteAccount()}
      />
    </>
  );
}

export function AccountPanel({
  controller,
  onClose,
  open,
  persistent,
  view,
}: {
  controller: AccountController;
  onClose: () => void;
  open: boolean;
  persistent: boolean;
  view: SignedInView;
}) {
  const text = useAccountText();
  return (
    <ModalDialog
      open={open}
      titleId="account-panel-title"
      descriptionId="account-panel-intro"
      onCancel={onClose}
    >
      <div className={accountClasses.header}>
        <h2 id="account-panel-title" className={accountClasses.title}>
          {text("panelTitle")}
        </h2>
        <button
          className={accountClasses.button}
          type="button"
          data-initial-focus
          onClick={onClose}
        >
          {text("close")}
        </button>
      </div>
      <p id="account-panel-intro" className={accountClasses.text}>
        {text("panelIntro")}
      </p>
      <SyncSection controller={controller} persistent={persistent} view={view} />
      <StorageSection view={view} />
      <ConsentSettings controller={controller} view={view} />
      <SessionSections controller={controller} view={view} />
    </ModalDialog>
  );
}

/** First-login question with equal-weight answers; focus starts on the question, not a choice. */
export function ConsentDialog({
  busy,
  onChoose,
  onLater,
  open,
}: {
  busy: boolean;
  onChoose: (participation: boolean) => void;
  onLater: () => void;
  open: boolean;
}) {
  const text = useAccountText();
  return (
    <ModalDialog
      open={open}
      titleId="account-consent-title"
      descriptionId="account-consent-detail"
      onCancel={onLater}
    >
      <h2
        id="account-consent-title"
        className={accountClasses.title}
        tabIndex={-1}
        data-initial-focus
      >
        {text("consentHeading")}
      </h2>
      <p className={`${accountClasses.text} mt-2 font-semibold text-text`}>
        {text("consentQuestion")}
      </p>
      <p id="account-consent-detail" className={`${accountClasses.text} mt-2`}>
        {text("consentDetail")}
      </p>
      <div className={`${accountClasses.row} mt-4`}>
        <button
          className={accountClasses.button}
          type="button"
          disabled={busy}
          onClick={() => onChoose(true)}
        >
          {text("consentYes")}
        </button>
        <button
          className={accountClasses.button}
          type="button"
          disabled={busy}
          onClick={() => onChoose(false)}
        >
          {text("consentNo")}
        </button>
        <button className={accountClasses.button} type="button" onClick={onLater}>
          {text("consentLater")}
        </button>
      </div>
    </ModalDialog>
  );
}

export function InputSummary({ input, title }: { input: CalculatorInput | null; title: string }) {
  const text = useAccountText();
  const { formatInteger, t } = useI18n();
  return (
    <section className={accountClasses.summary} aria-label={title}>
      <h3 className={accountClasses.heading}>{title}</h3>
      {input ? (
        <dl className={accountClasses.summaryList}>
          <dt>{t("state.gradeAria")}</dt>
          <dd className="m-0 font-semibold">{input.grade}</dd>
          <dt>{t("state.phaseAria")}</dt>
          <dd className="m-0 font-semibold">{formatInteger(input.level)}</dd>
          <dt>{t("state.currentExp")}</dt>
          <dd className="m-0 font-semibold">{formatInteger(input.exp)}</dd>
          {KIT_ORDER.map((kit) => (
            <div className="contents" key={kit}>
              <dt>{t(KIT_LABEL_KEYS[kit])}</dt>
              <dd className="m-0 font-semibold">{formatInteger(input.stock[kit])}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={accountClasses.text}>{text("conflictEmpty")}</p>
      )}
    </section>
  );
}

export function ConflictDialog({
  conflict,
  onChoose,
}: {
  conflict: WorkspaceConflict | null;
  onChoose: (choice: ConflictChoice) => void;
}) {
  const text = useAccountText();
  return (
    <ModalDialog
      open={conflict !== null}
      titleId="account-conflict-title"
      descriptionId="account-conflict-detail"
      onCancel={() => onChoose("cancel")}
    >
      {conflict ? (
        <>
          <h2
            id="account-conflict-title"
            className={accountClasses.title}
            tabIndex={-1}
            data-initial-focus
          >
            {text("conflictTitle")}
          </h2>
          <p id="account-conflict-detail" className={`${accountClasses.text} mt-2`}>
            {text("conflictDetail")}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 max-mobile:grid-cols-1">
            <InputSummary
              input={conflict.server}
              title={text("conflictServer", { revision: conflict.serverRevision })}
            />
            <InputSummary input={conflict.local} title={text("conflictLocal")} />
          </div>
          <div className={`${accountClasses.row} mt-4`}>
            <button
              className={accountClasses.button}
              type="button"
              onClick={() => onChoose("server")}
            >
              {text("conflictKeepServer")}
            </button>
            <button
              className={accountClasses.button}
              type="button"
              onClick={() => onChoose("local")}
            >
              {text("conflictOverwrite")}
            </button>
            <button
              className={accountClasses.button}
              type="button"
              onClick={() => onChoose("cancel")}
            >
              {text("conflictCancel")}
            </button>
          </div>
        </>
      ) : null}
    </ModalDialog>
  );
}

/** Sign-out with unsynced edits: keeping them on this device is preselected and focused. */
export function SignOutDialog({
  kind,
  onCancel,
  onConfirm,
}: {
  kind: "logout" | "revoke" | null;
  onCancel: () => void;
  onConfirm: (keepUnsynced: boolean) => void;
}) {
  const text = useAccountText();
  const [keep, setKeep] = useState(true);
  useEffect(() => {
    if (kind) setKeep(true);
  }, [kind]);
  return (
    <ModalDialog
      open={kind !== null}
      titleId="account-signout-title"
      descriptionId="account-signout-detail"
      onCancel={onCancel}
    >
      <h2 id="account-signout-title" className={accountClasses.title}>
        {text("signOutTitle")}
      </h2>
      <p id="account-signout-detail" className={`${accountClasses.text} mt-2`}>
        {text("signOutDetail")}
      </p>
      <fieldset className="m-0 mt-3 grid gap-1 border-0 p-0">
        <legend className={accountClasses.heading}>{text("signOutLegend")}</legend>
        <label className={accountClasses.choice}>
          <input
            type="radio"
            name="account-signout"
            data-initial-focus
            checked={keep}
            onChange={() => setKeep(true)}
          />
          {text("signOutKeep")}
        </label>
        <label className={accountClasses.choice}>
          <input
            type="radio"
            name="account-signout"
            checked={!keep}
            onChange={() => setKeep(false)}
          />
          {text("signOutDelete")}
        </label>
      </fieldset>
      <div className={`${accountClasses.row} mt-4 justify-end`}>
        <button className={accountClasses.button} type="button" onClick={onCancel}>
          {text("cancel")}
        </button>
        <button
          className={keep ? accountClasses.primary : accountClasses.danger}
          type="button"
          onClick={() => onConfirm(keep)}
        >
          {text(kind === "revoke" ? "revokeAll" : "logout")}
        </button>
      </div>
    </ModalDialog>
  );
}
