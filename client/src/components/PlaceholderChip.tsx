/** 라벨 옆 스파인 플레이스홀더 이름(`.spine`). 위자드 1~3단계에서 그 값이 들어갈 자리를 보여 준다. */
export function PlaceholderChip({ name }: { name: string }) {
  return <span className="spine">{name}</span>;
}
