import type { LayoutPreset } from './store'

export type RailPanel = 'navigator' | 'resources'

/**
 * A viewport this much taller than it is wide switches to the mobile layout.
 * Orientation alone decides it — no width threshold — so rotating a device (or
 * making a window portrait) flips the layout at exactly the same ratio.
 */
export const MOBILE_ASPECT_RATIO = 1.1

/**
 * Mobile stacks one window per screenful in a scrolling column, so the
 * multi-pane presets (2-up and the tile grids) have no room to be legible.
 */
export const MOBILE_LAYOUT_PRESET: LayoutPreset = 'single'

export function isMobileViewport(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false
  if (width <= 0 || height <= 0) return false
  return height > width * MOBILE_ASPECT_RATIO
}

/**
 * The preset the workspace actually renders with. The saved per-Desktop preset
 * is left untouched so rotating back to landscape restores the real layout.
 */
export function viewportLayoutPreset(preset: LayoutPreset, mobile: boolean): LayoutPreset {
  return mobile ? MOBILE_LAYOUT_PRESET : preset
}

/**
 * Mobile has no hover, so the rail icons toggle a bottom sheet instead of the
 * peek-on-hover panel: tapping the icon of the sheet already open closes it.
 */
export function nextRailSheet(current: RailPanel | null, tapped: RailPanel): RailPanel | null {
  return current === tapped ? null : tapped
}
