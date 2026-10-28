const TEXT = { pass: 'PASS', fail: 'FAIL', info: 'INFO' }, CLS = { pass: 'ok', fail: 'no', info: 'info' };

/** 검수 결과 꼬리표(`.st`): PASS / FAIL / INFO. */
export function StatusChip({ status }: { status: 'pass' | 'fail' | 'info' }) {
  return <span className={`st ${CLS[status]}`}>{TEXT[status]}</span>;
}
