/**
 * Permission-preset presentation and picker option assembly — the terminal
 * mirror of the web client's display conventions
 * (dsh-client-ui-permission-presets presentation), kept pure for unit tests.
 */

import type { SelectItem } from '@earendil-works/pi-tui'
import { CUSTOM_PRESET, type PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'

/**
 * Convert conventional kebab-case preset names into user-facing title case.
 * Mirrors the web client's `displayPresetName`: a non-kebab label (a host
 * configured name) passes through unchanged.
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Render a permission preset under its product label. Mirrors the web
 * client's `displayPermissionPreset`: `danger-full-access` gets the product
 * label "Full access", everything else its conventional display name.
 */
export function displayPermissionPreset(value: string, name: string): string {
  return value === 'danger-full-access' ? 'Full access' : displayPresetName(name)
}

/**
 * Assemble the picker rows for the permission preset table: every advertised
 * preset in declaration order, plus the derived `custom` option exactly while
 * it is current (custom is display state — a matching knob bundle — not a
 * switch target). The description falls back to the resolved sandbox/approval
 * bundle when the preset has no configured description.
 */
export function permissionItems(presets: PermissionPresetService, current: string | undefined): SelectItem[] {
  const names = current === CUSTOM_PRESET ? [...presets.names, CUSTOM_PRESET] : [...presets.names]
  return names.map(name => {
    const option = presets.optionOf(name)
    const label = displayPermissionPreset(option.value, option.name)
    if (name === CUSTOM_PRESET) {
      return { value: option.value, label, description: option.description }
    }
    const spec = presets.resolve(name)
    return {
      value: option.value,
      label,
      description: option.description ?? `sandbox: ${spec.sandbox} · approval: ${spec.approval}`,
    }
  })
}
