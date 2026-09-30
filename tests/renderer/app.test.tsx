import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from '@/renderer/app/App';

test('App renders the application shell', () => {
  render(<App />);
  expect(
    screen.getByRole('heading', { name: 'Bengkelin' }),
  ).toBeInTheDocument();
});
