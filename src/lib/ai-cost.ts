// Standard gpt-transcribe estimate, checked September 5, 2026:
// https://developers.openai.com/api/docs/pricing (Transcription models).
// These are application budget estimates, not a reconciliation of provider invoices.
const TRANSCRIPTION_USD_PER_MINUTE = 0.0045;

/** Standard-tier GPT-5.6 Sol; use the long-context rates at the threshold conservatively.
 * Cached-input discounts are deliberately not deducted from the budget estimate. */
export function interpretationEstimatedUsd(inputTokens: number, outputTokens: number): number {
  if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Nonnegative provider token counts are required.");
  }
  const longContext = inputTokens >= 272_000;
  return (inputTokens * (longContext ? 8 : 4) + outputTokens * (longContext ? 30 : 20)) / 1_000_000;
}

function verifiedSeconds(durationSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 120) {
    throw new Error("A server-verified recording of no more than 120 seconds is required.");
  }
  return Math.ceil(durationSeconds);
}

export function transcriptionEstimatedUsd(durationSeconds: number): number {
  return Math.ceil((verifiedSeconds(durationSeconds) / 60) * TRANSCRIPTION_USD_PER_MINUTE * 1_000_000) / 1_000_000;
}

export function transcriptionReservationUsd(durationSeconds: number): number {
  // Reserve before contacting the provider, with a margin and a one-cent floor.
  // Unknown outcomes retain this reservation; confirmed responses settle the estimate.
  return Math.max(0.01, Math.ceil(transcriptionEstimatedUsd(durationSeconds) * 1.5 * 1_000_000) / 1_000_000);
}
