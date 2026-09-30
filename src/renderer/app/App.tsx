import { cn } from '@/renderer/lib/utils';

export function App() {
  return (
    <main
      className={cn(
        'flex min-h-screen items-center justify-center',
        'bg-background text-foreground',
      )}
    >
      <h1 className="text-2xl font-semibold">Bengkelin</h1>
    </main>
  );
}
