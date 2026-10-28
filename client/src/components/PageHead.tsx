import type { ReactNode } from 'react';

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: string; title: string; lead?: string; actions?: ReactNode }) {
  return (
    <div className="head">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
        {lead && <p>{lead}</p>}
      </div>
      {actions && <div className="head-tools">{actions}</div>}
    </div>
  );
}
