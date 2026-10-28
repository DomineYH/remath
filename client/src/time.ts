// 화면 날짜·시각 형식 하나(#31): 브라우저 로컬 시간대. CSV started_at 은 데이터 내보내기라 ISO(UTC) 그대로다(C13).
const p = (n: number) => String(n).padStart(2, '0');

/** ISO → `YYYY-MM-DD` (로컬). */
export const localDate = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
/** ISO → `YYYY-MM-DD HH:MM` (로컬). */
export const localDateTime = (iso: string) => { const d = new Date(iso); return `${localDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`; };
