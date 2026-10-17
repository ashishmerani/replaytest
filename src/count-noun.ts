/** Returns the grammatically correct noun for an already-rendered numeric count. */
export function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
