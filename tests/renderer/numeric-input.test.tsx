import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import {
  NumberFormatProvider,
  useNumberFormat,
} from '@/renderer/lib/number-format';
import type { NumberFormat } from '@/shared/contracts';

function Field({
  format = 'ID',
  initial = '',
  decimal = false,
  negative = false,
  changed = () => {},
}: {
  format?: NumberFormat;
  initial?: string;
  decimal?: boolean;
  negative?: boolean;
  changed?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <NumberFormatProvider format={format} systemLocale="fr-FR">
      <NumericInput
        aria-label="Amount"
        value={value}
        decimal={decimal}
        negative={negative}
        onValueChange={(next) => {
          setValue(next);
          changed(next);
        }}
      />
      <output data-testid="raw">{value}</output>
      <Money value={value || '0'} />
    </NumberFormatProvider>
  );
}
function Money({ value }: { value: string }) {
  const { formatIdr } = useNumberFormat();
  return <span>{/^\d+$/.test(value) ? formatIdr(value) : ''}</span>;
}

describe('numeric text input', () => {
  test('groups while typing and keeps canonical values', async () => {
    const user = userEvent.setup();
    render(<Field />);
    const input = screen.getByRole('textbox');
    await user.type(input, '12345eEabc');
    expect(input).toHaveValue('12.345');
    expect(screen.getByTestId('raw')).toHaveTextContent('12345');
    expect(screen.getByText('Rp 12.345')).toBeInTheDocument();
    fireEvent.wheel(input, { deltaY: 100 });
    expect(input).toHaveValue('12.345');
  });
  test('accepts localized paste and rejects malformed/scientific paste as a whole', async () => {
    const user = userEvent.setup();
    render(<Field format="US" />);
    const input = screen.getByRole('textbox');
    await user.click(input);
    await user.paste('9,223,372,036,854,775,807');
    expect(input).toHaveValue('9,223,372,036,854,775,807');
    await user.clear(input);
    await user.type(input, '5');
    await user.paste('1e5');
    expect(input).toHaveValue('5');
    await user.paste('12,34');
    expect(input).toHaveValue('5');
  });
  test('preserves decimal editing values and permitted negative input', async () => {
    const user = userEvent.setup();
    render(<Field decimal negative />);
    const input = screen.getByRole('textbox');
    await user.type(input, '-1234,50');
    expect(input).toHaveValue('-1.234,50');
    expect(screen.getByTestId('raw')).toHaveTextContent('-1234.50');
    await user.keyboard('{Backspace}{Backspace}');
    expect(input).toHaveValue('-1.234,');
  });
  test('keeps the caret when inserting in the middle and deleting beside a group', async () => {
    const user = userEvent.setup();
    render(<Field initial="12345" />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.click(input);
    input.setSelectionRange(3, 3);
    await user.keyboard('9');
    expect(input).toHaveValue('129.345');
    expect(input.selectionStart).toBe(3);
    input.setSelectionRange(4, 4);
    await user.keyboard('{Backspace}');
    expect(input).toHaveValue('12.345');
    expect(input.selectionStart).toBe(2);
    input.setSelectionRange(2, 2);
    await user.keyboard('{Delete}');
    expect(input).toHaveValue('1.245');
  });
  test('reformats without changing the value or firing updates', async () => {
    const changed = vi.fn();
    const user = userEvent.setup();
    const view = render(<Field initial="12345.50" decimal changed={changed} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.click(input);
    input.setSelectionRange(1, 4);
    fireEvent.select(input);
    view.rerender(
      <Field format="US" initial="12345.50" decimal changed={changed} />,
    );
    expect(input).toHaveValue('12,345.50');
    expect(screen.getByTestId('raw')).toHaveTextContent('12345.50');
    expect(changed).not.toHaveBeenCalled();
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(4);
  });
});
