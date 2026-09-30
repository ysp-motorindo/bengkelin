import type { ImportIssueDto } from '@/shared/contracts';

/**
 * One import finding. Errors block the commit; warnings are informational.
 * `code` doubles as the i18n key `errors.<code>`, so the renderer translates
 * issues exactly like Result errors.
 */
export interface Issue {
  severity: 'error' | 'warning';
  row: number | null;
  column: string | null;
  sku: string | null;
  code: string;
  params?: Record<string, string>;
}

export function issueError(
  code: string,
  at: { row: number | null; column?: string | null; sku?: string | null },
  params?: Record<string, string>,
): Issue {
  return {
    severity: 'error',
    row: at.row,
    column: at.column ?? null,
    sku: at.sku ?? null,
    code,
    ...(params ? { params } : {}),
  };
}

export function issueWarning(
  code: string,
  at: { row: number | null; column?: string | null; sku?: string | null },
  params?: Record<string, string>,
): Issue {
  return { ...issueError(code, at, params), severity: 'warning' };
}

/** File-level issues first, then by record number (stable within a row). */
export function sortIssues(issues: Issue[]): Issue[] {
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort(
      (a, b) => (a.issue.row ?? 0) - (b.issue.row ?? 0) || a.index - b.index,
    )
    .map(({ issue }) => issue);
}

export function toIssueDto(issue: Issue): ImportIssueDto {
  return {
    row: issue.row,
    column: issue.column,
    sku: issue.sku,
    error: {
      code: issue.code,
      messageKey: `errors.${issue.code}`,
      ...(issue.params ? { params: issue.params } : {}),
    },
  };
}
