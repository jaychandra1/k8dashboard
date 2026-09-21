import { useMemo } from 'react';
import { highlight } from '../../lib/hljs';

/**
 * The ONLY place that uses dangerouslySetInnerHTML. `highlight()` returns
 * hljs-escaped HTML, or the fully escaped raw text on failure.
 *
 *   <HighlightedCode code={yaml} lang="yaml" className="yaml-code" />
 */
export default function HighlightedCode({ code, lang = 'yaml', className = '', trailingNewline = false, preProps = {}, codeProps = {} }) {
  const html = useMemo(() => highlight(code, lang) + (trailingNewline ? '\n' : ''), [code, lang, trailingNewline]);
  return (
    <pre className={className} {...preProps}>
      <code className={`hljs language-${lang}`} {...codeProps} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

export { HighlightedCode };
