// deploy.sh 2단계: 미적용 마이그레이션만 번호 순으로. psql 은 가짜로 바꾼다; 실 DB 는 수동(T-4).
import { describe, expect, it } from 'vitest';
import { migrate, pending, type Psql } from './migrate.ts';

describe('pending migrations (D-15)', () => {
  const files = ['0002_auth_atomic.sql', '0001_init.test.ts', '0001_init.sql', 'package.json', '0010_later.sql', 'tsconfig.json'];

  it('empty project: every NNNN_<name>.sql in number order, nothing else', () => {
    expect(pending(files, [])).toEqual(['0001_init.sql', '0002_auth_atomic.sql', '0010_later.sql']);
  });
  it('only versions missing from schema_migrations', () => {
    expect(pending(files, ['0001', '0002'])).toEqual(['0010_later.sql']);
    expect(pending(files, ['0001', '0002', '0010'])).toEqual([]);
  });

  /** schema_migrations 를 흉내 내는 psql: -f 로 파일을 "적용"하면 그 버전을 기록한다. failOn = 그 파일에서 실패. */
  function fakePsql(applied: string[] | null, failOn?: string) {
    const calls: string[][] = [];
    const psql: Psql = args => {
      calls.push(args);
      const sql = args[args.indexOf('-c') + 1];
      if (args.includes('-f')) {
        const f = args.at(-1)!;
        if (f.endsWith(failOn ?? '\0')) throw new Error(`psql exited 3 on ${f}`);
        (applied ??= []).push(f.split('/').at(-1)!.slice(0, 4));
        return '';
      }
      if (sql.includes('to_regclass')) return applied ? 't\n' : 'f\n';
      if (!applied) throw new Error('relation "schema_migrations" does not exist');
      return applied.map(v => v + '\n').join('');
    };
    return { psql, calls };
  }

  it('applies each pending file with --single-transaction and ON_ERROR_STOP', () => {
    const { psql, calls } = fakePsql(null);
    expect(migrate(psql, files, '/m/')).toEqual({ applied: [], ran: ['0001_init.sql', '0002_auth_atomic.sql', '0010_later.sql'] });
    expect(calls.filter(c => c.includes('-f'))).toEqual(['0001_init.sql', '0002_auth_atomic.sql', '0010_later.sql']
      .map(f => ['--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', `/m/${f}`]));
  });

  it('a second run applies nothing', () => {
    const { psql, calls } = fakePsql(['0001', '0002', '0010']);
    expect(migrate(psql, files, '/m/').ran).toEqual([]);
    expect(calls.some(c => c.includes('-f'))).toBe(false);
  });

  it('stops at the first failing file', () => {
    const { psql, calls } = fakePsql(['0001'], '0002_auth_atomic.sql');
    expect(() => migrate(psql, files, '/m/')).toThrow(/0002_auth_atomic/);
    expect(calls.filter(c => c.includes('-f')).map(c => c.at(-1))).toEqual(['/m/0002_auth_atomic.sql']);
  });
});
