// The API page's endpoints and their code snippets. Plain strings, no React, so
// highlight.check.ts can run every generated snippet through the highlighter.
import type { Lang } from './highlight';

export type Method = 'GET' | 'POST' | 'PATCH';
export interface Endpoint {
  id: string;
  method: Method;
  path: string;
  title: string;
  body?: Record<string, unknown>;
}

/** The code panel's tabs in order, and the highlighter each one uses. */
export type LangId = 'curl' | 'node' | 'python' | 'selenium' | 'playwright';
export const LANG: Record<LangId, Lang> = { curl: 'sh', node: 'js', python: 'py', selenium: 'py', playwright: 'js' };

export function endpoints(id: string, scriptId: string): Endpoint[] {
  const p = encodeURIComponent(id);
  return [
    { id: 'list', method: 'GET', path: '/api/sessions', title: 'List profiles' },
    { id: 'create', method: 'POST', path: '/api/sessions/create', title: 'Create a profile', body: { name: 'new-profile' } },
    { id: 'launch', method: 'POST', path: '/api/sessions/launch', title: 'Start profiles', body: { ids: [id], url: 'https://example.com' } },
    { id: 'cdp', method: 'POST', path: `/api/sessions/${p}/cdp`, title: 'Connect Playwright / Selenium' },
    { id: 'stop', method: 'POST', path: '/api/sessions/stop', title: 'Stop a profile', body: { id } },
    { id: 'pool', method: 'GET', path: '/api/pool', title: 'Status' },
    { id: 'run', method: 'POST', path: '/api/scripts/run', title: 'Run a script', body: { scriptId, ids: [id] } },
    { id: 'op', method: 'POST', path: `/api/sessions/${p}/op`, title: 'Run one op', body: { op: 'goto', url: 'https://example.com' } },
    { id: 'proxy', method: 'PATCH', path: `/api/sessions/${p}`, title: 'Set proxy', body: { proxy: 'http://user:pass@host:port' } },
    { id: 'cookies-get', method: 'GET', path: `/api/sessions/${p}/cookies`, title: 'Get cookies' },
    {
      id: 'cookies-set',
      method: 'POST',
      path: `/api/sessions/${p}/cookies`,
      title: 'Set cookies',
      body: { cookies: [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }] },
    },
    { id: 'template', method: 'POST', path: '/api/templates/template-id/create', title: 'Create from a template', body: { name: 'new-profile' } },
    { id: 'proxies', method: 'GET', path: '/api/proxies', title: 'List proxies' },
  ];
}

const q = (s: string) => JSON.stringify(s);

export function snippets(origin: string, e: Endpoint): Record<LangId, string> {
  const url = origin + e.path;
  const m = e.method;
  const get = m === 'GET';
  const json = e.body ? JSON.stringify(e.body) : '';
  const curl = get
    ? `curl ${url}`
    : json
      ? `curl -X ${m} ${url} \\\n  -H "X-SMP: 1" -H "Content-Type: application/json" \\\n  -d '${json}'`
      : `curl -X ${m} ${url} -H "X-SMP: 1"`;
  const node = get
    ? `const r = await fetch(${q(url)});\nconsole.log(await r.json());`
    : `const r = await fetch(${q(url)}, {\n  method: ${q(m)},\n` +
      (json ? `  headers: { "X-SMP": "1", "Content-Type": "application/json" },\n  body: JSON.stringify(${json}),\n` : `  headers: { "X-SMP": "1" },\n`) +
      `});\nconsole.log(await r.json());`;
  // The example bodies hold no booleans or null, so their JSON doubles as a Python literal.
  const python = get
    ? `import requests\n\nprint(requests.get(${q(url)}).json())`
    : `import requests\n\nr = requests.${m.toLowerCase()}(${q(url)}, ${json ? `json=${json}, ` : ''}headers={"X-SMP": "1"})\nprint(r.json())`;
  const cdp = e.id === 'cdp';
  const playwright =
    `import { ${cdp ? 'chromium, ' : ''}request } from "playwright";\n\n` +
    `const api = await request.newContext({\n  baseURL: ${q(origin)},\n  extraHTTPHeaders: { "X-SMP": "1" },\n});\n` +
    `const r = await api.${m.toLowerCase()}(${q(e.path)}${json ? `, { data: ${json} }` : ''});\n` +
    (cdp
      ? `const { wsEndpoint } = await r.json();\nconst browser = await chromium.connectOverCDP(wsEndpoint);\n` +
        `const page = browser.contexts()[0].pages()[0];\nconsole.log(await page.title());\n` +
        `await browser.close(); // disconnects; the profile keeps running`
      : `console.log(await r.json());`);
  // Selenium drives a running Chromium profile through its DevTools port; plain calls are Python.
  const selenium = cdp
    ? `import requests
from selenium import webdriver

` +
      `r = requests.post(${q(url)}, headers={"X-SMP": "1"})
` +
      `ws = r.json()["wsEndpoint"]

` +
      `opts = webdriver.ChromeOptions()
opts.debugger_address = ws.split("/")[2]
` +
      `# attach to the running profile
driver = webdriver.Chrome(options=opts)
print(driver.title)`
    : python;
  return { curl, node, python, selenium, playwright };
}
