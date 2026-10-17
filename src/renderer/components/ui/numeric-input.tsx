import type { ComponentProps } from 'react';
import { Input } from './input';

interface NumericInputProps extends Omit<
  ComponentProps<typeof Input>,
  'type' | 'inputMode' | 'onChange'
> {
  decimal?: boolean;
  negative?: boolean;
  onValueChange(value: string): void;
}

export function NumericInput({
  decimal = false,
  negative = false,
  onValueChange,
  ...props
}: NumericInputProps) {
  const pattern = decimal
    ? negative
      ? /^-?\d*(?:[.,]\d*)?$/
      : /^\d*(?:[.,]\d*)?$/
    : negative
      ? /^-?\d*$/
      : /^\d*$/;
  return (
    <Input
      {...props}
      type="text"
      inputMode={decimal || negative ? 'decimal' : 'numeric'}
      onChange={(event) => {
        const value = event.target.value;
        if (pattern.test(value)) onValueChange(value);
      }}
    />
  );
}
