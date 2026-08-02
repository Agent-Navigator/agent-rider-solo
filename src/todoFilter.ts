export type TodoCompletionFilter = 'unchecked' | 'checked'

export function todoMatchesCompletionFilter(completed: boolean, filter: TodoCompletionFilter) {
  return completed === (filter === 'checked')
}
