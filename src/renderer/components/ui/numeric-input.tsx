import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useReducer,
  type ComponentProps,
} from 'react';
import {
  formatNumericText,
  numberSymbols,
  parseNumericText,
} from '@/shared/number-format';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { Input } from './input';

interface NumericInputProps extends Omit<
  ComponentProps<typeof Input>,
  'type' | 'inputMode' | 'onChange' | 'value' | 'defaultValue'
> {
  value: string;
  decimal?: boolean;
  negative?: boolean;
  onValueChange(value: string): void;
}

export function NumericInput({
  value,
  decimal = false,
  negative = false,
  onValueChange,
  onKeyDown,
  onPaste,
  ref,
  ...props
}: NumericInputProps) {
  const { locale } = useNumberFormat();
  const input = useRef<HTMLInputElement>(null);
  const [, rerender] = useReducer((version: number) => version + 1, 0);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const pendingSelection = useRef(false);
  const previousLocale = useRef(locale);
  useImperativeHandle(ref, () => input.current!);
  const display = formatNumericText(value, locale);
  const { group } = numberSymbols(locale);
  const meaningful = (text: string) =>
    group ? text.split(group).join('').length : text.length;

  useLayoutEffect(() => {
    const changedLocale = previousLocale.current !== locale;
    previousLocale.current = locale;
    if (
      (!changedLocale && !pendingSelection.current) ||
      !selection.current ||
      document.activeElement !== input.current
    )
      return;
    function positionFor(count: number) {
      let position = 0;
      while (
        position < display.length &&
        meaningful(display.slice(0, position)) < count
      )
        position++;
      return position;
    }
    input.current?.setSelectionRange(
      positionFor(selection.current.start),
      positionFor(selection.current.end),
    );
    pendingSelection.current = false;
  });

  function accept(text: string, position: number) {
    const next = parseNumericText(text, locale, { decimal, negative });
    if (next === null) return;
    const count = meaningful(text.slice(0, position));
    selection.current = { start: count, end: count };
    pendingSelection.current = true;
    rerender();
    if (next !== value) onValueChange(next);
  }

  return (
    <Input
      {...props}
      ref={input}
      type="text"
      inputMode={decimal || negative ? 'decimal' : 'numeric'}
      value={display}
      onChange={(event) =>
        accept(
          event.target.value,
          event.target.selectionStart ?? event.target.value.length,
        )
      }
      onSelect={(event) => {
        if (pendingSelection.current) return;
        const element = event.currentTarget;
        selection.current = {
          start: meaningful(
            element.value.slice(0, element.selectionStart ?? 0),
          ),
          end: meaningful(element.value.slice(0, element.selectionEnd ?? 0)),
        };
        props.onSelect?.(event);
      }}
      onBlur={(event) => {
        selection.current = null;
        props.onBlur?.(event);
      }}
      onPaste={(event) => {
        onPaste?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        const pasted = event.clipboardData.getData('text');
        if (!pasted) return;
        if (
          parseNumericText(pasted, locale, { decimal, negative }, true) === null
        )
          return;
        const element = event.currentTarget;
        const start = element.selectionStart ?? 0;
        const end = element.selectionEnd ?? start;
        const next = display.slice(0, start) + pasted + display.slice(end);
        accept(next, start + pasted.length);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          !group
        )
          return;
        const element = event.currentTarget;
        const start = element.selectionStart ?? 0;
        if (start !== element.selectionEnd) return;
        const back =
          event.key === 'Backspace' &&
          display.slice(start - group.length, start) === group;
        const forward =
          event.key === 'Delete' &&
          display.slice(start, start + group.length) === group;
        if (!back && !forward) return;
        event.preventDefault();
        const from = back ? Math.max(0, start - group.length - 1) : start;
        const to = back ? start : start + group.length + 1;
        accept(display.slice(0, from) + display.slice(to), from);
      }}
    />
  );
}
