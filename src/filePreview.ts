import type { FsEntry, FsFilePreview, FsListing, FsSearchResultEntry } from './store'

export const FILE_CHANGE_POLL_INTERVAL_MS = 1_500

export interface FilePreviewWindow extends FsFilePreview {
  restoreRequest: number
}

export function countPreviewLines(content: string | null | undefined): number | null {
  if (content == null) return null
  if (content.length === 0) return 0
  return (content.match(/\r\n|\r|\n/g)?.length ?? 0) + 1
}

export function previewLineCountLabel(content: string | null | undefined): string | null {
  const count = countPreviewLines(content)
  if (count == null) return null
  return `${count} line${count === 1 ? '' : 's'}`
}

export function filePreviewsMatch(left: FsFilePreview, right: FsFilePreview) {
  return left.name === right.name
    && left.path === right.path
    && left.size === right.size
    && left.modifiedAt === right.modifiedAt
    && left.kind === right.kind
    && left.mime === right.mime
    && left.content === right.content
    && left.dataUrl === right.dataUrl
    && left.viewUrl === right.viewUrl
}

export function mergeOpenedFilePreview(current: FilePreviewWindow[], opened: FsFilePreview) {
  const existingIndex = current.findIndex((preview) => preview.path === opened.path)
  if (existingIndex < 0) return [...current, { ...opened, restoreRequest: 0 }]
  return current.map((preview, index) => index === existingIndex
    ? { ...opened, restoreRequest: preview.restoreRequest + 1 }
    : preview)
}

export function mergeRefreshedFilePreview(current: FilePreviewWindow, refreshed: FsFilePreview): FilePreviewWindow {
  return { ...refreshed, restoreRequest: current.restoreRequest }
}

function fileEntriesMatch(
  left: Array<FsEntry & { type?: 'file' | 'dir'; size?: number | null }>,
  right: Array<FsEntry & { type?: 'file' | 'dir'; size?: number | null }>,
) {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index]
    return entry.name === candidate?.name
      && entry.path === candidate.path
      && entry.modifiedAt === candidate.modifiedAt
      && entry.type === candidate.type
      && entry.size === candidate.size
  })
}

export function fileListingsMatch(left: FsListing | null, right: FsListing) {
  return left?.root === right.root
    && left.path === right.path
    && left.parent === right.parent
    && fileEntriesMatch(left.dirs, right.dirs)
    && fileEntriesMatch(left.files ?? [], right.files ?? [])
}

export function fileSearchResultsMatch(left: FsSearchResultEntry[] | null, right: FsSearchResultEntry[]) {
  return left !== null && fileEntriesMatch(left, right)
}
