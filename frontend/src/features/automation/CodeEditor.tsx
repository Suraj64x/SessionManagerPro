import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { tokens } from '../apidocs/highlight';

/**
 * The script editor: a highlighted copy of the code and a line gutter under a transparent
 * textarea, so typing stays a plain textarea (undo, spellcheck off, Tab handling, the caret)
 * while the colours come from the same tokenizer the API snippets use. All three layers share
 * the font metrics, and the two read-only ones follow the textarea's scroll.
 */
export const CodeEditor: React.FC<{
  value: string;
  onChange: (code: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  readOnly?: boolean;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
}> = ({ value, onChange, onKeyDown, onFocus, readOnly, textRef }) => {
  const hl = useRef<HTMLPreElement>(null);
  const nums = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split('\n').length, [value]);
  const parts = useMemo(() => tokens(value, 'js'), [value]);

  // The layers are painted from `value`, so they must be back in step before the browser paints.
  const sync = () => {
    const ta = textRef.current;
    if (!ta) return;
    if (hl.current) {
      hl.current.scrollTop = ta.scrollTop;
      hl.current.scrollLeft = ta.scrollLeft;
    }
    if (nums.current) nums.current.scrollTop = ta.scrollTop;
  };
  useLayoutEffect(sync, [value]);

  return (
    <div className="code-edit">
      <div className="code-nums" ref={nums} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <pre className="code-hl" ref={hl} aria-hidden="true">
        {parts.map(([kind, text], i) => (kind ? <span key={i} className={`tok-${kind}`}>{text}</span> : text))}
        {'\n'}
      </pre>
      <textarea
        ref={textRef}
        className="code"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={sync}
        readOnly={readOnly}
        aria-label="Script code"
        title="Tab indents · Esc then Tab leaves the editor"
        onFocus={onFocus}
      />
    </div>
  );
};
