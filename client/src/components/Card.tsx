import { useId, type ReactNode } from 'react';
import { Avatar } from './Avatar.tsx';

/** 둥근 카드 하나: 머리(이모지·제목·작은 글씨·오른쪽 꼬리표) + 본문 + 하단 버튼 줄. article 이라 제목으로 찾을 수 있다. */
export function Card({ title, sub, avatar, badge, actions, children }: { title: string; sub?: ReactNode; avatar?: string; badge?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  const id = useId();
  return (
    <article className="card" aria-labelledby={id}>
      <div className="who">
        {avatar && <Avatar emoji={avatar} />}
        <div><h3 id={id}>{title}</h3>{sub && <small>{sub}</small>}</div>
        {badge && <span style={{ marginLeft: 'auto' }}>{badge}</span>}
      </div>
      {children}
      {actions && <div className="acts">{actions}</div>}
    </article>
  );
}
