import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { FormField } from '@/renderer/components/form-field';
import { Input } from '@/renderer/components/ui/input';

describe('FormField messages', () => {
  test('shows a hint in a keyboard and pointer tooltip beside the label', async () => {
    const user = userEvent.setup();
    render(
      <FormField label="Amount" hint="Enter a whole number.">
        <Input />
      </FormField>,
    );

    const trigger = screen.getByRole('button', {
      name: 'Enter a whole number.',
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Enter a whole number.');
    expect(tooltip).toHaveClass('group-hover:visible');
    expect(tooltip).toHaveClass('bg-card');
    expect(trigger).toHaveClass('hover:bg-transparent');
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(tooltip).toHaveClass('group-focus-within:visible');
  });

  test('shows validation errors in a warning tooltip and marks the control invalid', () => {
    render(
      <FormField label="Amount" error="workspace.validation.wholeNumber">
        <Input />
      </FormField>,
    );

    const trigger = screen.getByRole('button', {
      name: 'Masukkan bilangan bulat.',
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Masukkan bilangan bulat.');
    expect(trigger).toHaveClass('text-destructive');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'aria-describedby',
      tooltip.id,
    );
  });
});
