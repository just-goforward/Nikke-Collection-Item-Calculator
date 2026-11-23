import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/locale';
import type { PreviewReader } from '../lib/previewCalendar';
import PreviewSupply from './PreviewSupply';
import { watchPreviewPublication, type PublicationView } from './watchPreviewPublication';

const copy = {
  ko: { title: '공식 공지에서 확인한 일정', partial: '일부 일정만 확인했습니다. 전체 일정이나 보상을 확정할 수 없어 이 자료로 대기일을 계산하지 않습니다.', unavailable: '표시할 수 있는 검증된 일정이 없습니다. 일정이 없다는 뜻은 아닙니다.', checking: '서명된 일정을 확인하는 중입니다.', asOf: '게시 시각', solo: '솔로 레이드', cooperation: '협동작전', source: '공식 공지' },
  en: { title: 'Schedules confirmed in official notices', partial: 'Only the listed intervals are verified. This does not establish full schedule or reward coverage and cannot determine a wait date.', unavailable: 'No verified schedule is available to display. This does not mean there are no events.', checking: 'Checking the signed schedule.', asOf: 'Published', solo: 'Solo Raid', cooperation: 'Coordinated Operation', source: 'Official notice' },
  ja: { title: '公式のお知らせで確認できた日程', partial: '記載した期間のみ確認できました。全日程や報酬は確定できないため、この情報から待機日数は計算しません。', unavailable: '表示できる検証済みの日程がありません。開催予定がないという意味ではありません。', checking: '署名された日程を確認しています。', asOf: '公開時刻', solo: 'ソロレイド', cooperation: '協同作戦', source: '公式のお知らせ' },
};
const updating = {
  ko: '직전 검증 일정 · 갱신 중',
  en: 'Previously verified schedule · updating',
  ja: '前回検証した日程 · 更新中',
};

const loadCalendar = async () => (await import('../lib/previewCalendar')).createCollectedCalendarReader();
// Keep the certified forecast acquisition graph out of the initial application bundle.
const loadSupply = async () => (await import('../lib/previewTimedSupplyReader')).readPreviewTimedSupply;
function usePublication<T>(load: () => Promise<PreviewReader<T>>) {
  const [calendar, setCalendar] = useState<PublicationView<T>>({ status: 'checking', value: null });
  useEffect(() => watchPreviewPublication(load, setCalendar), [load]);
  return calendar;
}

export default function CollectedCalendar() {
  const { locale } = useI18n();
  const { value: calendar, status } = usePublication(loadCalendar);
  const supply = usePublication(loadSupply);
  const c = copy[locale];
  const date = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' });
  return <><section className="min-w-0 rounded-card border border-border p-3 text-sm" data-testid="collected-calendar" data-publication-state={status} aria-label={c.title}>
    <details>
      <summary className="cursor-pointer py-2"><h2 className="inline font-semibold">{c.title}</h2></summary>
      {status === 'updating' && <p role="status">{updating[locale]}</p>}
      <p>{status === 'checking' ? c.checking : calendar?.status === 'partial' ? c.partial : c.unavailable}</p>
      {calendar && <>
        <p className="text-muted">{c.asOf}: <time dateTime={new Date(calendar.issuedAt).toISOString()}>{date.format(calendar.issuedAt)} KST</time></p>
        {calendar.status === 'partial' && <ul>{calendar.events.map(event => <li key={`${event.kind}:${event.startsAt}:${event.endsAt}`}>
          {c[event.kind]}: <time dateTime={event.startsAt}>{date.format(Date.parse(event.startsAt))}</time> – <time dateTime={event.endsAt}>{date.format(Date.parse(event.endsAt))} KST</time>
          {' · '}<a href={event.sourceUrl} rel="noopener noreferrer" target="_blank" className="underline">{c.source}</a>
        </li>)}</ul>}
      </>}
    </details>
  </section><PreviewSupply live={supply} /></>;
}
