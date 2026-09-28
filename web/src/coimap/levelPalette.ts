/**
 * Colours for the "colour by height" view of the buildings layer.
 *
 * A level is an offset from the terrain, so the scale is diverging around the ground:
 * a neutral grey at 0, one blue hue stepping lighter with each level up — lighter reads
 * as nearer on a dark map — and a single red pole for anything buried below it. Grey at
 * the midpoint keeps what sits on the ground recessive, which is the point: the view is
 * for seeing what is lifted over it. Levels past the last step share it; a conveyor tops
 * out at +5 and elevated track at +6, and a legend with a swatch per level of a 21-high
 * stacker rail would be unreadable.
 *
 * Steps are the validated reference palette's: blue 600→100 for the rise, its dark-mode
 * red for the pole, its dark neutral for the midpoint.
 */
import { parseHex } from './terrain';

const BELOW = '#e66767';
const GROUND = '#383835';
const RISE = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];

/** The highest level with its own colour; everything above shares it. */
export const TOP_LEVEL = RISE.length;

/** The one stop below the ground: every buried level shares it, as they share a colour. */
export const BELOW_GROUND = -1;

/** A stop on the level scale as the legend names it. */
export function levelLabel(level: number): string {
  if (level <= BELOW_GROUND) return 'Below ground';
  if (level === 0) return 'Ground';
  return level >= TOP_LEVEL ? `+${TOP_LEVEL} and up` : `+${level}`;
}

const rgb = { below: parseHex(BELOW), ground: parseHex(GROUND), rise: RISE.map(parseHex) };

export function levelRgb(level: number): readonly [number, number, number] {
  if (level < 0) return rgb.below;
  if (level === 0) return rgb.ground;
  return rgb.rise[Math.min(level, TOP_LEVEL) - 1]!;
}

/** Legend rows, top of the scale first, as the map reads: the highest things stand out. */
export const LEVEL_LEGEND: { label: string; color: string }[] = [
  ...RISE.map((color, i) => ({ label: levelLabel(i + 1), color })).reverse(),
  { label: levelLabel(0), color: GROUND },
  { label: levelLabel(BELOW_GROUND), color: BELOW },
];
