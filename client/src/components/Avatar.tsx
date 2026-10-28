/** 학생·멘토 이모지 원. 장식이라 읽지 않는다(이름이 옆에 있다). */
export function Avatar({ emoji }: { emoji: string }) {
  return <span className="av" aria-hidden="true">{emoji}</span>;
}
