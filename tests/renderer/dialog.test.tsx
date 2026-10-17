import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Dialog } from '@/renderer/components/ui/dialog';

afterEach(() => vi.useRealTimers());

describe('Dialog scrolling', () => {
  test('shows the scrollbar while content scrolls, then hides it', () => {
    vi.useFakeTimers();
    render(
      <Dialog title="Long content" onClose={vi.fn()}>
        <div>Content</div>
      </Dialog>,
    );

    const panel = screen.getByRole('dialog');
    const scrollArea = panel.querySelector('.dialog-scroll-area');
    expect(scrollArea).not.toBeNull();

    fireEvent.scroll(scrollArea!);
    expect(scrollArea).toHaveAttribute('data-scrolling', 'true');
    act(() => vi.advanceTimersByTime(700));
    expect(scrollArea).toHaveAttribute('data-scrolling', 'false');
  });
});
