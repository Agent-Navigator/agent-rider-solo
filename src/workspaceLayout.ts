export type TwoUpColumn = 0 | 1

/** Pick the least occupied 2-up column, preferring the left on a tie. */
export function nextTwoUpColumn(
  keys: string[],
  columnOf: (key: string) => number,
): TwoUpColumn {
  let left = 0
  let right = 0
  for (const key of keys) {
    if (columnOf(key) === 1) right += 1
    else left += 1
  }
  return right < left ? 1 : 0
}
