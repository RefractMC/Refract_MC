export interface ThemeColors {
  'bg-base': string
  'bg-surface': string
  'bg-overlay': string
  'bg-hover': string
  'text-primary': string
  'text-secondary': string
  'text-muted': string
  'accent': string
  'accent-hover': string
  'accent-fg': string
  'success': string
  'warning': string
  'error': string
  'border': string
  'radius': string
}

export interface LayoutConfig {
  sidebarWidth: string
  sidebarCollapsedWidth: string
  titlebarHeight: string
  statusbarHeight: string
}

export interface ThemeDefinition {
  id: string
  name: string
  author?: string
  version?: string
  colors: ThemeColors
  layout?: Partial<LayoutConfig>
  backgroundImage?: string
  backgroundOpacity?: number
  backgroundBlur?: number
  backgroundDim?: number
  disableGradients?: boolean
  customCSS?: string
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  sidebarWidth: '240px',
  sidebarCollapsedWidth: '64px',
  titlebarHeight: '40px',
  statusbarHeight: '28px',
}
