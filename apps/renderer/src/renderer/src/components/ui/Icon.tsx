import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  CloudUploadIcon,
  Copy01Icon,
  Edit02Icon,
  ExternalLinkIcon,
  FingerPrintIcon,
  FileKeyIcon,
  InformationCircleIcon,
  LibraryIcon,
  Link02Icon,
  Logout01Icon,
  MagicWand01Icon,
  NewsIcon,
  Notification01Icon,
  PackageOpenIcon,
  PackageSearchIcon,
  RadioIcon,
  RefreshIcon,
  SecurityCheckIcon,
  ServerStack01Icon,
  Settings01Icon,
  Shirt01Icon,
  Tick01Icon,
  UserAdd01Icon,
  UserMultipleIcon,
  UserRemove01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from '@hugeicons/react'
import { forwardRef } from 'react'

export type IconProps = Omit<HugeiconsIconProps, 'icon'>

function createIcon(displayName: string, icon: IconSvgElement) {
  const Component = forwardRef<SVGSVGElement, IconProps>((props, ref) => (
    <HugeiconsIcon ref={ref} icon={icon} {...props} />
  ))
  Component.displayName = displayName
  return Component
}

export type IconComponent = ReturnType<typeof createIcon>

export const Add = createIcon('Add', Add01Icon)
export const ArrowLeft = createIcon('ArrowLeft', ArrowLeft01Icon)
export const ArrowRight = createIcon('ArrowRight', ArrowRight01Icon)
export const Bell = createIcon('Bell', Notification01Icon)
export const Check = createIcon('Check', Tick01Icon)
export const CheckCircle2 = createIcon('CheckCircle2', CheckmarkCircle01Icon)
export const ChevronDown = createIcon('ChevronDown', ArrowDown01Icon)
export const Copy = createIcon('Copy', Copy01Icon)
export const Edit = createIcon('Edit', Edit02Icon)
export const ExternalLink = createIcon('ExternalLink', ExternalLinkIcon)
export const FileKey2 = createIcon('FileKey2', FileKeyIcon)
export const Fingerprint = createIcon('Fingerprint', FingerPrintIcon)
export const Info = createIcon('Info', InformationCircleIcon)
export const Library = createIcon('Library', LibraryIcon)
export const Link2 = createIcon('Link2', Link02Icon)
export const LogOut = createIcon('LogOut', Logout01Icon)
export const MagicWand = createIcon('MagicWand', MagicWand01Icon)
export const Newspaper = createIcon('Newspaper', NewsIcon)
export const PackageOpen = createIcon('PackageOpen', PackageOpenIcon)
export const PackageSearch = createIcon('PackageSearch', PackageSearchIcon)
export const Radio = createIcon('Radio', RadioIcon)
export const RefreshCw = createIcon('RefreshCw', RefreshIcon)
export const Server = createIcon('Server', ServerStack01Icon)
export const Settings = createIcon('Settings', Settings01Icon)
export const ShieldCheck = createIcon('ShieldCheck', SecurityCheckIcon)
export const Shirt = createIcon('Shirt', Shirt01Icon)
export const UploadCloud = createIcon('UploadCloud', CloudUploadIcon)
export const UserAdd = createIcon('UserAdd', UserAdd01Icon)
export const Users = createIcon('Users', UserMultipleIcon)
export const UserRemove = createIcon('UserRemove', UserRemove01Icon)
export const X = createIcon('X', Cancel01Icon)
