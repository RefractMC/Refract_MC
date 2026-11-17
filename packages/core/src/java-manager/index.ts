// Shared native Java inventory contract. Detection and provisioning live in Rust.
export interface JavaInstallation {
  version: number
  path: string
  vendor: string
  architecture?: string
  custom?: boolean
}
