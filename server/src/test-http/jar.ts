// test:http (#46): a fetch that keeps cookies like a browser on one host (set-cookie → jar → cookie header), so createHttpApi runs in Node.
// One jarFetch = one browser. Domain, Secure and SameSite are ignored: the run talks to one http origin.
interface Cookie { name: string; value: string; path: string; expires: number }

/** RFC 6265 5.1.4: the cookie path is the request path or a parent directory of it. */
const pathMatch = (req: string, path: string) => req === path || (req.startsWith(path) && (path.endsWith('/') || req[path.length] === '/'));

/** RFC 6265 5.1.4 default-path: the request path up to (not including) its last '/'. */
const defaultPath = (req: string) => req.lastIndexOf('/') > 0 ? req.slice(0, req.lastIndexOf('/')) : '/';

export function jarFetch(f: typeof fetch = fetch) {
  const jar = new Map<string, Cookie>();   // key = name + path, as a browser keys them
  const keep = (line: string, url: URL, now: number) => {
    const [pair, ...attrs] = line.split(';'), i = pair.indexOf('=');
    if (i < 1) return;
    const c: Cookie = { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), path: defaultPath(url.pathname), expires: Infinity };
    let maxAge: number | undefined;
    for (const a of attrs) {
      const [k, v = ''] = a.split('=').map(s => s.trim()), key = k.toLowerCase();
      if (key === 'path' && v.startsWith('/')) c.path = v;
      else if (key === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
      else if (key === 'expires' && !Number.isNaN(Date.parse(v))) c.expires = Date.parse(v);
    }
    if (maxAge !== undefined) c.expires = now + maxAge * 1000;   // Max-Age wins over Expires
    const k = `${c.name}\0${c.path}`;
    if (c.expires <= now) jar.delete(k); else jar.set(k, c);
  };
  const wrapped = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), now = Date.now();
    const sent = [...jar.values()].filter(c => c.expires > now && pathMatch(url.pathname, c.path))
      .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
    const headers = new Headers(init.headers);
    if (sent) headers.set('cookie', sent);
    const res = await f(url, { ...init, headers });
    for (const line of res.headers.getSetCookie()) keep(line, url, now);
    return res;
  };
  return Object.assign(wrapped as typeof fetch, { jar });
}
