import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { CardTitle } from '@/renderer/components/ui/card';

describe('heading hierarchy', () => {
  test('card titles are section headings by default', () => {
    render(<CardTitle>Shop information</CardTitle>);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Shop information' }),
    ).toBeInTheDocument();
  });

  test('standalone titles can remain page headings', () => {
    render(<CardTitle level={1}>Sign in</CardTitle>);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeInTheDocument();
  });
});
