import { useEffect, useRef } from 'react';
import { cn } from '@/renderer/lib/utils';

/**
 * Shows a print template (a complete HTML document from main) inside a
 * Shadow DOM, so preview, print and PDF share ONE template while its CSS
 * stays isolated from the app.
 *
 * The renderer CSP is unchanged (no 'unsafe-inline'): the document is
 * parsed into an inert <template> (nothing runs, loads or applies), its
 * <style> text becomes a constructable stylesheet adopted by the shadow
 * root, which CSP does not treat as an inline <style> element, and the
 * <style> elements themselves are dropped. As defense in depth, active
 * elements, remote URLs and inline event-handler attributes are removed
 * before the markup is imported.
 */

/** Preview-only adjustments: paper look, and no viewport-fixed layers. */
const PREVIEW_CSS = `
:host { display: block; }
.sheet { box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); }
.sheet.receipt { margin: 0 auto; box-sizing: content-box; padding: 3mm 5mm 6mm; }
.sheet.layout-a4 { margin: 0 auto; box-sizing: content-box; padding: 14mm 12mm; }
.sheet .void-watermark { position: absolute; }
`;

const BLOCKED =
  'script, style, title, iframe, object, embed, link, meta, base, form';

function sanitize(root: ParentNode): void {
  root.querySelectorAll(BLOCKED).forEach((node) => node.remove());
  root.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const isHandler = name.startsWith('on');
      const isUrl = name === 'src' || name === 'href' || name === 'srcset';
      if (isHandler || (isUrl && !/^data:image\//i.test(attribute.value))) {
        element.removeAttribute(attribute.name);
      }
    }
  });
}

function adoptStyles(shadow: ShadowRoot, css: string): void {
  const supported =
    typeof CSSStyleSheet !== 'undefined' &&
    'replaceSync' in CSSStyleSheet.prototype &&
    'adoptedStyleSheets' in shadow;
  if (!supported) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css + PREVIEW_CSS);
  shadow.adoptedStyleSheets = [sheet];
}

export function ShadowDocument({
  html,
  label,
  className,
}: {
  html: string;
  label: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    const template = document.createElement('template');
    template.innerHTML = html;
    const content = template.content;
    const css = Array.from(content.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    sanitize(content);
    adoptStyles(shadow, css);
    shadow.replaceChildren(document.importNode(content, true));
  }, [html]);

  return (
    <div
      ref={host}
      role="document"
      aria-label={label}
      data-testid="print-preview-document"
      className={cn('bg-neutral-200 p-4 text-black', className)}
    />
  );
}
