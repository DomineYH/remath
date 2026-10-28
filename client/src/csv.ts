// 대화 CSV 내려받기(I-43·I-45·I-47): 같은 필터 하나로 기록 탭·시나리오 카드·사용자 행·삭제 확인창이 모두 쓴다.
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from './apis.ts';
import { toast } from './components/Toast.tsx';
import { errorText, useT } from './i18n/index.tsx';

/** 파일 이름 = remath_<종류>_<대상>_<YYYYMMDD>.csv (목업과 같다). 파일 이름에 못 쓰는 글자는 _ 로. */
const csvName = (kind: string, key: string) => `remath_${kind}_${key.replace(/[\\/:*?"<>|\s]+/g, '_')}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;

/** Blob 바이트 그대로 <a download> 로 저장한다(text() 를 거치면 BOM 이 벗겨진다). */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function useDownloadCsv() {
  const t = useT();
  return async (filter: z.infer<typeof S.SessionFilter>, kind: string, key: string) => {
    const name = csvName(kind, key);
    try { saveBlob(await adminApi.downloadSessionsCsv(filter), name); toast(t('csvSaved', name)); } catch (e) { toast(errorText(t, e)); }
  };
}
