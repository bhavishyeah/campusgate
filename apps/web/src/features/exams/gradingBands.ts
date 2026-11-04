import type { GradingBand } from "./types";

export type BandValidation = { ok: true } | { ok: false; message: string };

/** Percent (0..100, up to 2dp) -> integer basis points. */
export function pctToBps(pct: number): number {
  return Math.round(pct * 100);
}

/** Integer basis points -> percent. */
export function bpsToPct(bps: number): number {
  return bps / 100;
}

/**
 * Mirrors the server band rules: start at 0, end at 10000, contiguous (no gaps,
 * no overlaps), isPassing monotonic non-decreasing.
 */
export function validateBands(bands: GradingBand[]): BandValidation {
  if (bands.length === 0) return { ok: false, message: "At least one band is required" };

  const sorted = [...bands].sort((a, b) => a.minPercentBps - b.minPercentBps);

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].minPercentBps === sorted[i - 1].minPercentBps) {
      return {
        ok: false,
        message: `Bands "${sorted[i - 1].gradeLabel}" and "${sorted[i].gradeLabel}" start at the same value`,
      };
    }
  }

  for (const b of sorted) {
    if (
      !(
        b.minPercentBps >= 0 &&
        b.minPercentBps < b.maxPercentBps &&
        b.maxPercentBps <= 10000
      )
    ) {
      return {
        ok: false,
        message: `Band ${b.gradeLabel || "(unnamed)"}: min must be less than max and within 0 to 100%`,
      };
    }
  }

  if (sorted[0].minPercentBps !== 0) {
    return { ok: false, message: "Bands must start at 0%" };
  }
  if (sorted[sorted.length - 1].maxPercentBps !== 10000) {
    return { ok: false, message: "Bands must end at 100%" };
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (next.minPercentBps > prev.maxPercentBps) {
      return { ok: false, message: `Gap between ${prev.gradeLabel} and ${next.gradeLabel}` };
    }
    if (next.minPercentBps < prev.maxPercentBps) {
      return { ok: false, message: `Overlap between ${prev.gradeLabel} and ${next.gradeLabel}` };
    }
  }

  let seenPassing = false;
  for (const b of sorted) {
    if (b.isPassing) seenPassing = true;
    else if (seenPassing) {
      return {
        ok: false,
        message: "Passing must not revert to failing once a band passes",
      };
    }
  }

  return { ok: true };
}
