// Self-check for the snippet tokenizer. Run: node src/features/apidocs/highlight.check.ts
// (Node 22.18+ strips the types itself; nothing imports this file, so it never ships.)
import { tokens, type Lang, type Tok } from './highlight.ts';
import { endpoints, LANG, snippets, type LangId } from './snippets.ts';

const eq = (got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const of = (code: string, lang: Lang, kind: Tok) => tokens(code, lang).filter(([k]) => k === kind).map(([, s]) => s);

// Hand-made cases for the rules the generated snippets rarely hit (comments, numbers).
const sh = `curl -X POST http://127.0.0.1:47301/api/sessions/create \\\n  -H "X-SMP: 1" -H "Content-Type: application/json" \\\n  -d '{"name":"new-profile"}'`;
const js = `const r = await fetch("http://127.0.0.1:47301/api/pool", {\n  method: "POST",\n  body: JSON.stringify({"ids":["p-1"]}),\n});\nconsole.log(await r.json()); // if (x)`;
const py = `import requests\n\nr = requests.post("http://x/api#in", json={"a": 1}, headers={"X-SMP": "1"})\nprint(r.json())  # True`;

for (const [code, lang] of [[sh, 'sh'], [js, 'js'], [py, 'py']] as const) {
  eq(tokens(code, lang).map(([, s]) => s).join(''), code); // lossless: every character comes back once
}
eq(of(sh, 'sh', 'fn'), ['curl']);
eq(of(sh, 'sh', 'kw'), ['-X', '-H', '-H', '-d']); // the dashes inside the URL stay plain
eq(of(sh, 'sh', 'str'), ['"X-SMP: 1"', '"Content-Type: application/json"', `'{"name":"new-profile"}'`]);
eq(of(sh, 'sh', 'punct'), ['\\', '\\']);
eq(of(js, 'js', 'kw'), ['const', 'await', 'await']); // "if" sits inside the comment
eq(of(js, 'js', 'fn'), ['fetch', 'stringify', 'log', 'json']);
eq(of(js, 'js', 'com'), ['// if (x)']);
eq(of(py, 'py', 'kw'), ['import']); // not "in" from the URL, nor "True" from the comment
eq(of(py, 'py', 'fn'), ['post', 'print', 'json']); // json= is a name, r.json() a call
eq(of(py, 'py', 'num'), ['1']);
eq(of(py, 'py', 'com'), ['# True']);

// Every snippet the page generates, in every tab, comes back whole.
const origin = 'http://127.0.0.1:47301';
const all = endpoints('qa-p-1', 'script-1');
for (const e of all) {
  const code = snippets(origin, e);
  for (const id of Object.keys(LANG) as LangId[]) eq(tokens(code[id], LANG[id]).map(([, s]) => s).join(''), code[id]);
}
const byId = (id: string) => snippets(origin, all.find((e) => e.id === id)!);

// Playwright: APIRequestContext for a plain call...
const launch = byId('launch').playwright;
eq(of(launch, 'js', 'kw'), ['import', 'from', 'const', 'await', 'const', 'await', 'await']);
eq(of(launch, 'js', 'fn'), ['newContext', 'post', 'log', 'json']);
eq(of(launch, 'js', 'str').slice(0, 3), ['"playwright"', `"${origin}"`, '"X-SMP"']);
// ...and connectOverCDP on the wsEndpoint the cdp route returns.
const cdp = byId('cdp');
eq(of(cdp.playwright, 'js', 'fn'), ['newContext', 'post', 'json', 'connectOverCDP', 'contexts', 'pages', 'log', 'title', 'close']);
eq(of(cdp.playwright, 'js', 'num'), ['0', '0']);
eq(of(cdp.playwright, 'js', 'com'), ['// disconnects; the profile keeps running']);
// A POST without a body sends no JSON in any language.
eq(cdp.curl, `curl -X POST ${origin}/api/sessions/qa-p-1/cdp -H "X-SMP: 1"`);
eq(of(cdp.curl, 'sh', 'kw'), ['-X', '-H']);
eq([cdp.node, cdp.python, cdp.playwright].some((s) => /Content-Type|json=|data:/.test(s)), false);
console.log('highlight.check: ok');
