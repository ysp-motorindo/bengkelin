import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
function loadWidths(
  storageKey: string,
  minimumWidths: readonly number[],
): number[] | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? 'null',
    );
    return Array.isArray(value) &&
      value.length === minimumWidths.length &&
      value.every(
        (width, i) =>
          typeof width === 'number' &&
          Number.isFinite(width) &&
          width >= minimumWidths[i]!,
      )
      ? value
      : null;
  } catch {
    return null;
  }
}
function saveWidths(storageKey: string, widths: number[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(widths));
  } catch {
    /* Resizing still works when storage is unavailable. */
  }
}
export function ResizableTransactionTable({
  caption,
  columns,
  storageKey,
  children,
}: {
  caption: string;
  columns: readonly { label: string; minWidth: number }[];
  storageKey: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const minimumWidths = columns.map((column) => column.minWidth);
  const headings = columns.map((column) => column.label);
  const table = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useState(() =>
    loadWidths(storageKey, minimumWidths),
  );
  const drag = useRef<{
    index: number;
    start: number;
    widths: number[];
    previous: number[] | null;
    pointerId: number;
  } | null>(null);
  const measuredWidths = () =>
    widths ??
    Array.from(table.current!.querySelectorAll('th'), (th, i) =>
      Math.max(minimumWidths[i]!, th.getBoundingClientRect().width),
    );
  const resized = (base: number[], index: number, delta: number) =>
    base.map((width, i) =>
      i === index ? Math.max(minimumWidths[i]!, width + delta) : width,
    );
  function cancelDrag() {
    if (!drag.current) return;
    setWidths(drag.current.previous);
    drag.current = null;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table
        ref={table}
        style={{
          width: widths ? widths.reduce((a, b) => a + b, 0) : '100%',
          minWidth: minimumWidths.reduce((a, b) => a + b, 0),
        }}
        className="table-fixed border-collapse text-xs"
      >
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {minimumWidths.map((width, i) => (
            <col
              key={i}
              style={{ width: widths?.[i] ?? (i === 2 ? undefined : width) }}
            />
          ))}
        </colgroup>
        <thead className="bg-sunken text-left font-semibold text-muted-foreground">
          <tr>
            {headings.map((label, index) => (
              <th
                scope="col"
                key={index}
                className="relative border-b border-border px-2 py-2 text-center"
              >
                {label}
                <span
                  role="separator"
                  tabIndex={0}
                  aria-orientation="vertical"
                  aria-label={t('workspace.lines.resizeColumn', {
                    column: label,
                  })}
                  aria-valuemin={minimumWidths[index]}
                  aria-valuenow={widths?.[index] ?? minimumWidths[index]}
                  className="absolute inset-y-0 right-0 z-10 w-2 touch-none cursor-col-resize border-r border-border hover:bg-amber-300/50 focus-visible:bg-amber-300/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600"
                  onPointerDown={(event) => {
                    if (event.button !== 0 || drag.current) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = {
                      index,
                      start: event.clientX,
                      widths: measuredWidths(),
                      previous: widths,
                      pointerId: event.pointerId,
                    };
                  }}
                  onPointerMove={(event) => {
                    const active = drag.current;
                    if (active?.pointerId === event.pointerId)
                      setWidths(
                        resized(
                          active.widths,
                          active.index,
                          event.clientX - active.start,
                        ),
                      );
                  }}
                  onPointerUp={(event) => {
                    const active = drag.current;
                    if (active?.pointerId !== event.pointerId) return;
                    const next = resized(
                      active.widths,
                      active.index,
                      event.clientX - active.start,
                    );
                    drag.current = null;
                    setWidths(next);
                    saveWidths(storageKey, next);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onPointerCancel={cancelDrag}
                  onLostPointerCapture={cancelDrag}
                  onKeyDown={(event) => {
                    if (
                      drag.current ||
                      !['ArrowLeft', 'ArrowRight'].includes(event.key)
                    )
                      return;
                    event.preventDefault();
                    const next = resized(
                      measuredWidths(),
                      index,
                      event.key === 'ArrowRight' ? 8 : -8,
                    );
                    setWidths(next);
                    saveWidths(storageKey, next);
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
