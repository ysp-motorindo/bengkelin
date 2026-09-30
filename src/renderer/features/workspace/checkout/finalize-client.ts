import type {
  FinalizeInput,
  FinalizePreviewDto,
  InvoiceView,
  PreviewFinalizeInput,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

/**
 * The finalization hook of the checkout review (T9 -> T10). The shell passes
 * the bridge implementation; tests can pass their own.
 */
export interface FinalizeClient {
  previewFinalize(
    input: PreviewFinalizeInput,
  ): Promise<Result<FinalizePreviewDto>>;
  finalize(input: FinalizeInput): Promise<Result<InvoiceView>>;
}

export const bridgeFinalizeClient: FinalizeClient = {
  previewFinalize: (input) => window.bengkelin.invoices.previewFinalize(input),
  finalize: (input) => window.bengkelin.invoices.finalize(input),
};
