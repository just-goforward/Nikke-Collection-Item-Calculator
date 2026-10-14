import type { AppLocale } from "../i18n/locale";

/** Account-module strings, kept in the lazy account chunk instead of the shared catalogs. */
const ko = {
  login: "로그인",
  loginLabel: "Google 계정으로 로그인",
  loginBusy: "Google 로그인으로 이동 중…",
  loading: "계정 확인 중…",
  account: "계정",
  accountLabel: "계정 · {status}",
  panelTitle: "계정",
  panelIntro:
    "Google 계정으로 로그인되어 있습니다. 계산기 입력이 이 계정의 작업 공간에 저장됩니다. 로그인하지 않아도 모든 기능을 사용할 수 있습니다.",
  close: "닫기",
  cancel: "취소",
  syncHeading: "동기화",
  "sync.synced": "동기화됨",
  "sync.pending": "변경 사항 저장 대기 중",
  "sync.saving": "저장 중…",
  "sync.offline": "연결 대기 중 — 변경 사항은 이 기기에 보관되며 자동으로 다시 시도합니다",
  "sync.conflict": "충돌 — 어떤 버전을 유지할지 선택하세요",
  "sync.paused": "동기화 일시 중지됨 — 이 기기의 변경 사항은 보관되어 있습니다",
  "sync.error": "저장하지 못했습니다",
  syncRevision: "서버 버전 {revision}",
  syncNow: "지금 동기화",
  resolveConflict: "충돌 해결",
  storageHeading: "저장 공간",
  storageUsage: "{used} / {limit} 사용 ({percent})",
  storageUnknown: "사용량을 아직 불러오지 못했습니다.",
  archivingBlocked:
    "저장 공간 한도에 도달해 새 기록 보관이 중단되었습니다. 기존 데이터는 모두 그대로 보존되며 입력 저장은 계속할 수 있습니다.",
  deviceOnly:
    "이 브라우저에서는 기기 저장소를 쓸 수 없어, 저장되지 않은 변경 사항은 탭을 닫으면 사라질 수 있습니다.",
  consentHeading: "공개 주간 통계 참여",
  consentQuestion: "익명 처리된 공개 주간 통계에 참여하시겠습니까?",
  consentDetail:
    "참여하지 않아도 계산기와 개인 기능은 모두 똑같이 사용할 수 있습니다. 계정 설정에서 언제든 바꿀 수 있습니다.",
  consentYes: "참여하기",
  consentNo: "참여하지 않기",
  consentLater: "나중에 결정",
  consentCurrentYes: "현재: 참여 중",
  consentCurrentNo: "현재: 참여하지 않음",
  consentCurrentUnset: "현재: 아직 선택하지 않음 (참여하지 않음으로 처리)",
  consentSave: "선택 저장",
  dataHeading: "내 데이터",
  export: "데이터 내보내기 (JSON)",
  sessionsHeading: "로그인 세션",
  logout: "로그아웃",
  revokeAll: "모든 기기에서 로그아웃",
  sessionsDetail: "로그아웃하면 이 기기의 게스트 데이터로 돌아갑니다.",
  deleteHeading: "계정 삭제",
  deleteOpen: "계정 삭제…",
  deleteTitle: "계정을 영구 삭제할까요?",
  deleteDetail:
    "이 계정의 작업 공간, 기록과 통계 참여 정보가 서버에서 삭제되며 되돌릴 수 없습니다. 이 기기의 게스트 데이터는 유지됩니다.",
  deleteConfirmCheck: "되돌릴 수 없다는 것을 이해했습니다",
  deleteConfirm: "계정 영구 삭제",
  conflictTitle: "작업 공간이 다른 곳에서 변경되었습니다",
  conflictDetail:
    "다른 기기나 탭에서 저장된 버전과 이 기기의 변경 사항이 다릅니다. 어떤 버전을 유지할지 선택하세요.",
  conflictServer: "서버 버전 (버전 {revision})",
  conflictLocal: "이 기기의 버전",
  conflictEmpty: "저장된 입력 없음",
  conflictKeepServer: "서버 버전 유지",
  conflictOverwrite: "이 기기 버전으로 덮어쓰기",
  conflictCancel: "취소 (동기화 일시 중지)",
  reload: "새로고침",
  "stale.account_changed":
    "다른 탭에서 다른 계정으로 로그인했습니다. 이 탭을 새로고침하세요. 이 탭의 저장되지 않은 변경 사항은 원래 계정용으로 이 기기에 보관됩니다.",
  "stale.context_stale":
    "이 탭에 표시된 계정이 현재 로그인된 계정과 다릅니다. 덮어쓰지 않도록 저장을 멈췄습니다. 새로고침해 현재 계정의 데이터를 불러오세요.",
  "stale.context_required":
    "계정 확인 정보가 없어 요청이 거부되었습니다. 저장을 멈췄습니다. 새로고침한 뒤 다시 시도하세요.",
  "stale.signed_in_elsewhere":
    "다른 탭에서 로그인했습니다. 새로고침하면 계정 데이터를 사용할 수 있습니다.",
  dismiss: "알림 닫기",
  "notice.network": "서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
  "notice.service_unavailable":
    "계정 서비스를 일시적으로 사용할 수 없습니다. 계산기는 계속 사용할 수 있습니다.",
  "notice.login_failed": "로그인을 시작하지 못했습니다. 다시 시도하세요.",
  "notice.rate_limited": "시도가 너무 많습니다. 1분 뒤 다시 시도하세요.",
  "notice.beta_full": "베타 정원이 가득 찼습니다. 게스트로 모든 기능을 계속 사용할 수 있습니다.",
  "notice.account_switch_requires_logout": "다른 계정으로 로그인하려면 먼저 로그아웃하세요.",
  "notice.session_expired":
    "로그인이 만료되어 게스트 데이터로 전환했습니다. 저장되지 않은 계정 변경 사항은 이 기기에 보관됩니다.",
  "notice.logged_out": "로그아웃했습니다. 게스트 데이터로 돌아왔습니다.",
  "notice.logged_out_elsewhere": "다른 탭이나 기기에서 로그아웃되어 게스트 데이터로 전환했습니다.",
  "notice.revoked": "모든 기기에서 로그아웃했습니다.",
  "notice.deleted": "계정을 삭제했습니다.",
  "notice.deletion_pending": "계정 삭제 요청이 접수되어 처리 중입니다. 로그아웃되었습니다.",
  "notice.consent_saved": "통계 참여 설정을 저장했습니다.",
  "notice.consent_conflict":
    "다른 곳에서 설정이 바뀌었습니다. 현재 값을 확인한 뒤 다시 저장하세요.",
  "notice.consent_pending": "이전 설정 변경이 아직 처리 중입니다. 잠시 후 다시 시도하세요.",
  "notice.export_ready": "내보내기 파일을 다운로드했습니다.",
  "notice.export_failed": "데이터를 내보내지 못했습니다.",
  "notice.request_too_large": "작업 공간이 너무 커서 저장할 수 없습니다.",
  "notice.archive_quota_reached":
    "저장 공간 한도에 도달해 새 기록은 보관되지 않았습니다. 기존 데이터는 모두 보존됩니다.",
  "notice.storage_unavailable":
    "이 브라우저에서는 기기 저장소를 쓸 수 없어, 저장되지 않은 변경 사항은 탭을 닫으면 사라질 수 있습니다.",
  "notice.updated_elsewhere": "다른 탭이나 기기에서 작업 공간이 변경되었습니다.",
  "notice.unexpected": "예기치 않은 오류가 발생했습니다. 계산기는 계속 사용할 수 있습니다.",
};

export type AccountMessageKey = keyof typeof ko;

const en: Record<AccountMessageKey, string> = {
  login: "Sign in",
  loginLabel: "Sign in with Google",
  loginBusy: "Opening Google sign-in…",
  loading: "Checking account…",
  account: "Account",
  accountLabel: "Account · {status}",
  panelTitle: "Account",
  panelIntro:
    "You are signed in with Google. Your calculator inputs are saved to this account's workspace. Every feature also works without signing in.",
  close: "Close",
  cancel: "Cancel",
  syncHeading: "Sync",
  "sync.synced": "Synced",
  "sync.pending": "Changes waiting to save",
  "sync.saving": "Saving…",
  "sync.offline":
    "Waiting for a connection — changes are kept on this device and retried automatically",
  "sync.conflict": "Conflict — choose which version to keep",
  "sync.paused": "Sync paused — changes on this device are kept",
  "sync.error": "Could not save",
  syncRevision: "Server revision {revision}",
  syncNow: "Sync now",
  resolveConflict: "Resolve conflict",
  storageHeading: "Storage",
  storageUsage: "{used} of {limit} used ({percent})",
  storageUnknown: "Usage has not loaded yet.",
  archivingBlocked:
    "Storage limit reached: new archiving is blocked. All existing data is kept, and you can still save your inputs.",
  deviceOnly:
    "Device storage is unavailable in this browser, so unsaved changes may be lost when this tab closes.",
  consentHeading: "Public weekly statistics",
  consentQuestion: "Participate in the anonymized public weekly statistics?",
  consentDetail:
    "Every calculator and personal feature works the same if you don't participate. You can change this anytime in account settings.",
  consentYes: "Participate",
  consentNo: "Don't participate",
  consentLater: "Decide later",
  consentCurrentYes: "Current: participating",
  consentCurrentNo: "Current: not participating",
  consentCurrentUnset: "Current: not decided (treated as not participating)",
  consentSave: "Save choice",
  dataHeading: "Your data",
  export: "Export data (JSON)",
  sessionsHeading: "Sessions",
  logout: "Sign out",
  revokeAll: "Sign out on all devices",
  sessionsDetail: "Signing out returns this device to its guest data.",
  deleteHeading: "Delete account",
  deleteOpen: "Delete account…",
  deleteTitle: "Permanently delete your account?",
  deleteDetail:
    "This account's workspace, records and statistics participation are deleted from the server. This cannot be undone. Guest data on this device is kept.",
  deleteConfirmCheck: "I understand this cannot be undone",
  deleteConfirm: "Delete permanently",
  conflictTitle: "Your workspace changed somewhere else",
  conflictDetail:
    "A version saved on another device or tab differs from the changes on this device. Choose which version to keep.",
  conflictServer: "Server version (revision {revision})",
  conflictLocal: "This device's version",
  conflictEmpty: "No saved inputs",
  conflictKeepServer: "Keep server version",
  conflictOverwrite: "Overwrite with this device's version",
  conflictCancel: "Cancel (pause sync)",
  reload: "Reload",
  "stale.account_changed":
    "Another tab signed in with a different account. Reload this tab. Unsaved changes from this tab stay on this device for the original account.",
  "stale.context_stale":
    "The account shown in this tab no longer matches the signed-in account. Saving stopped to avoid overwriting. Reload to load the current account's data.",
  "stale.context_required":
    "A request was rejected because the account confirmation was missing. Saving stopped. Reload and try again.",
  "stale.signed_in_elsewhere": "You signed in in another tab. Reload to use your account data.",
  dismiss: "Dismiss",
  "notice.network": "Could not reach the server. Try again shortly.",
  "notice.service_unavailable":
    "The account service is temporarily unavailable. The calculator keeps working.",
  "notice.login_failed": "Could not start sign-in. Try again.",
  "notice.rate_limited": "Too many attempts. Try again in a minute.",
  "notice.beta_full": "The beta is full. You can keep using every feature as a guest.",
  "notice.account_switch_requires_logout": "Sign out before signing in with a different account.",
  "notice.session_expired":
    "Your sign-in expired, so this tab switched to guest data. Unsaved account changes stay on this device.",
  "notice.logged_out": "Signed out. Your guest data is back.",
  "notice.logged_out_elsewhere":
    "Signed out from another tab or device, so this tab switched to guest data.",
  "notice.revoked": "Signed out on all devices.",
  "notice.deleted": "Your account was deleted.",
  "notice.deletion_pending":
    "Account deletion was accepted and is being processed. You are signed out.",
  "notice.consent_saved": "Statistics participation saved.",
  "notice.consent_conflict":
    "The setting changed elsewhere. Check the current value and save again.",
  "notice.consent_pending": "A previous change is still being processed. Try again shortly.",
  "notice.export_ready": "Export downloaded.",
  "notice.export_failed": "Could not export your data.",
  "notice.request_too_large": "The workspace is too large to save.",
  "notice.archive_quota_reached":
    "Storage limit reached, so the new record was not archived. All existing data is kept.",
  "notice.storage_unavailable":
    "Device storage is unavailable in this browser, so unsaved changes may be lost when this tab closes.",
  "notice.updated_elsewhere": "The workspace was updated in another tab or device.",
  "notice.unexpected": "Something went wrong. The calculator keeps working.",
};

const ja: Record<AccountMessageKey, string> = {
  login: "ログイン",
  loginLabel: "Googleアカウントでログイン",
  loginBusy: "Googleのログインに移動中…",
  loading: "アカウントを確認中…",
  account: "アカウント",
  accountLabel: "アカウント · {status}",
  panelTitle: "アカウント",
  panelIntro:
    "Googleアカウントでログインしています。計算機の入力はこのアカウントのワークスペースに保存されます。ログインしなくてもすべての機能を使えます。",
  close: "閉じる",
  cancel: "キャンセル",
  syncHeading: "同期",
  "sync.synced": "同期済み",
  "sync.pending": "変更の保存待ち",
  "sync.saving": "保存中…",
  "sync.offline": "接続待ち — 変更はこの端末に保持され、自動で再試行します",
  "sync.conflict": "競合 — 残すバージョンを選んでください",
  "sync.paused": "同期を一時停止中 — この端末の変更は保持されています",
  "sync.error": "保存できませんでした",
  syncRevision: "サーバー版 {revision}",
  syncNow: "今すぐ同期",
  resolveConflict: "競合を解決",
  storageHeading: "保存容量",
  storageUsage: "{limit}中{used}を使用（{percent}）",
  storageUnknown: "使用量をまだ読み込めていません。",
  archivingBlocked:
    "保存容量の上限に達したため、新しい記録のアーカイブは停止しています。既存のデータはすべて保持され、入力の保存は引き続きできます。",
  deviceOnly:
    "このブラウザーでは端末の保存領域を使えないため、未保存の変更はタブを閉じると失われる場合があります。",
  consentHeading: "公開週間統計への参加",
  consentQuestion: "匿名化された公開週間統計に参加しますか？",
  consentDetail:
    "参加しなくても計算機と個人機能はすべて同じように使えます。アカウント設定からいつでも変更できます。",
  consentYes: "参加する",
  consentNo: "参加しない",
  consentLater: "後で決める",
  consentCurrentYes: "現在: 参加中",
  consentCurrentNo: "現在: 参加していません",
  consentCurrentUnset: "現在: 未選択（不参加として扱います）",
  consentSave: "選択を保存",
  dataHeading: "データ",
  export: "データをエクスポート（JSON）",
  sessionsHeading: "ログインセッション",
  logout: "ログアウト",
  revokeAll: "すべての端末からログアウト",
  sessionsDetail: "ログアウトすると、この端末のゲストデータに戻ります。",
  deleteHeading: "アカウント削除",
  deleteOpen: "アカウントを削除…",
  deleteTitle: "アカウントを完全に削除しますか？",
  deleteDetail:
    "このアカウントのワークスペース、記録、統計参加情報がサーバーから削除され、元に戻せません。この端末のゲストデータは保持されます。",
  deleteConfirmCheck: "元に戻せないことを理解しました",
  deleteConfirm: "完全に削除",
  conflictTitle: "ワークスペースが別の場所で変更されました",
  conflictDetail:
    "別の端末やタブで保存された版と、この端末の変更が異なります。残す版を選んでください。",
  conflictServer: "サーバー版（版 {revision}）",
  conflictLocal: "この端末の版",
  conflictEmpty: "保存された入力なし",
  conflictKeepServer: "サーバー版を残す",
  conflictOverwrite: "この端末の版で上書き",
  conflictCancel: "キャンセル（同期を一時停止）",
  reload: "再読み込み",
  "stale.account_changed":
    "別のタブで別のアカウントにログインしました。このタブを再読み込みしてください。このタブの未保存の変更は元のアカウント用にこの端末に保持されます。",
  "stale.context_stale":
    "このタブに表示中のアカウントが、現在ログイン中のアカウントと一致しません。上書きを防ぐため保存を停止しました。再読み込みして現在のアカウントのデータを読み込んでください。",
  "stale.context_required":
    "アカウント確認情報がないためリクエストが拒否されました。保存を停止しました。再読み込みしてからもう一度お試しください。",
  "stale.signed_in_elsewhere":
    "別のタブでログインしました。再読み込みするとアカウントのデータを使えます。",
  dismiss: "通知を閉じる",
  "notice.network": "サーバーに接続できませんでした。しばらくしてから再試行してください。",
  "notice.service_unavailable":
    "アカウントサービスを一時的に利用できません。計算機は引き続き使えます。",
  "notice.login_failed": "ログインを開始できませんでした。もう一度お試しください。",
  "notice.rate_limited": "試行回数が多すぎます。1分後に再試行してください。",
  "notice.beta_full": "ベータの定員に達しました。ゲストとしてすべての機能を引き続き使えます。",
  "notice.account_switch_requires_logout":
    "別のアカウントでログインするには、先にログアウトしてください。",
  "notice.session_expired":
    "ログインの有効期限が切れたため、ゲストデータに切り替えました。未保存のアカウントの変更はこの端末に保持されます。",
  "notice.logged_out": "ログアウトしました。ゲストデータに戻りました。",
  "notice.logged_out_elsewhere":
    "別のタブまたは端末でログアウトされたため、ゲストデータに切り替えました。",
  "notice.revoked": "すべての端末からログアウトしました。",
  "notice.deleted": "アカウントを削除しました。",
  "notice.deletion_pending":
    "アカウント削除のリクエストを受け付け、処理中です。ログアウトしました。",
  "notice.consent_saved": "統計への参加設定を保存しました。",
  "notice.consent_conflict":
    "別の場所で設定が変更されました。現在の値を確認してから、もう一度保存してください。",
  "notice.consent_pending": "前回の変更がまだ処理中です。しばらくしてから再試行してください。",
  "notice.export_ready": "エクスポートファイルをダウンロードしました。",
  "notice.export_failed": "データをエクスポートできませんでした。",
  "notice.request_too_large": "ワークスペースが大きすぎるため保存できません。",
  "notice.archive_quota_reached":
    "保存容量の上限に達したため、新しい記録はアーカイブされませんでした。既存のデータはすべて保持されます。",
  "notice.storage_unavailable":
    "このブラウザーでは端末の保存領域を使えないため、未保存の変更はタブを閉じると失われる場合があります。",
  "notice.updated_elsewhere": "別のタブまたは端末でワークスペースが変更されました。",
  "notice.unexpected": "予期しないエラーが発生しました。計算機は引き続き使えます。",
};

const ACCOUNT_MESSAGES: Record<AppLocale, Record<AccountMessageKey, string>> = {
  ko,
  en,
  ja,
};

export function accountText(
  locale: AppLocale,
  key: AccountMessageKey,
  params: Record<string, string | number> = {},
): string {
  let text = ACCOUNT_MESSAGES[locale][key];
  for (const [name, value] of Object.entries(params))
    text = text.split(`{${name}}`).join(String(value));
  return text;
}
