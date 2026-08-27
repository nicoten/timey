/**
 * How strongly a day is shaded, from the hours logged against it.
 *
 * Five steps rather than a continuous ramp: discrete bands stay distinguishable
 * next to each other, where a smooth gradient turns into mush.
 */

export const INTENSITY_LEVELS = [0, 1, 2, 3, 4] as const;
export type IntensityLevel = (typeof INTENSITY_LEVELS)[number];

/** Upper bound in minutes for each level above zero. */
const THRESHOLDS = [2 * 60, 4 * 60, 6 * 60] as const;

export function intensityLevel(minutes: number): IntensityLevel {
  if (minutes <= 0) return 0;
  if (minutes <= THRESHOLDS[0]) return 1;
  if (minutes <= THRESHOLDS[1]) return 2;
  if (minutes <= THRESHOLDS[2]) return 3;
  return 4;
}
