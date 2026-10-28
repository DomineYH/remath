import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'dangerSolid'; size?: 'md' | 'sm'; wide?: boolean };
const VARIANT = { default: '', primary: 'primary', danger: 'danger', dangerSolid: 'danger solid' };

export function Button({ variant = 'default', size = 'md', wide, className, type = 'button', ...rest }: Props) {
  const cls = ['btn', VARIANT[variant], size === 'sm' && 'sm', wide && 'wide', className].filter(Boolean).join(' ');
  return <button type={type} className={cls} {...rest} />;
}
