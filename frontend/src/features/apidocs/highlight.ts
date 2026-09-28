// A tiny regex tokenizer for the API snippets: enough for the curl, fetch, requests and
// Playwright examples this feature generates (snippets.ts), not a general parser (see `tokens`).

export type Lang = 'sh' | 'js' | 'py';
export type Tok = 'kw' | 'str' | 'fn' | 'com' | 'num' | 'punct';

// One alternation, one capture group per rule. At each position the first rule that matches
// wins, so keywords beat calls (`if (`) and comments/strings swallow whatever is inside them.
// Rule sources must not contain capturing groups of their own.
const lexer = (rules: [Tok, string][]) => ({
  re: new RegExp(rules.map(([, src]) => `(${src})`).join('|'), 'gm'),
  kinds: rules.map(([kind]) => kind),
});

const STR = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;
const words = (list: string) => String.raw`\b(?:${list.split(' ').join('|')})\b`;
// A name followed by "(" is a call; then numbers; any other symbol is punctuation.
const CODE: [Tok, string][] = [
  ['fn', String.raw`\b[A-Za-z_]\w*(?=\s*\()`],
  ['num', String.raw`\b\d+(?:\.\d+)?\b`],
  ['punct', String.raw`[^\w\s]`],
];

const LEXERS: Record<Lang, ReturnType<typeof lexer>> = {
  sh: lexer([
    ['com', String.raw`(?<=^|\s)#.*`],
    ['str', String.raw`"(?:\\.|[^"\\])*"|'[^']*'`],
    ['kw', String.raw`(?<=^|\s)--?[A-Za-z][\w-]*`], // flags: a dash inside a URL never follows a space
    ['fn', String.raw`(?<=^[ \t]*)[A-Za-z_][\w.-]*`], // the command at the start of a line
    ['punct', String.raw`\\$`], // line continuation
  ]),
  js: lexer([
    ['com', String.raw`\/\/.*`],
    ['str', STR],
    ['kw', words('import from export const let var await async function return new if else for of in true false null undefined')],
    ...CODE,
  ]),
  py: lexer([
    ['com', '#.*'],
    ['str', STR],
    ['kw', words('import from as def return async await for in if elif else not and or with class lambda True False None')],
    ...CODE,
  ]),
};

/**
 * Splits `code` into [kind, text] pieces that join back to exactly `code`; kind '' is plain
 * text (names, spaces). Single-line strings and `//`/`#` comments only: no template literals,
 * block comments or triple-quoted strings, which the generated snippets never contain.
 */
export function tokens(code: string, lang: Lang): [Tok | '', string][] {
  const { re, kinds } = LEXERS[lang];
  const out: [Tok | '', string][] = [];
  let last = 0;
  for (const m of code.matchAll(re)) {
    if (m.index > last) out.push(['', code.slice(last, m.index)]);
    out.push([kinds[m.findIndex((g, i) => i > 0 && g !== undefined) - 1], m[0]]);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(['', code.slice(last)]);
  return out;
}
