/**
 * Extension Registry Generator
 *
 * Reads extensions.config.json and manifest.json files to generate:
 * - lib/extensions/_generated/extension-list.ts
 * - lib/extensions/_generated/enabled-extensions.ts
 *
 * Usage:
 *   npx tsx scripts/generate-extension-registry.ts          # Generate files
 *   npx tsx scripts/generate-extension-registry.ts --list    # List available extensions
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = path.join(ROOT, 'extensions.config.json')
const EXTENSIONS_DIR = path.join(ROOT, 'extensions')
const OUTPUT_DIR = path.join(ROOT, 'lib', 'extensions', '_generated')

// ── Types ────────────────────────────────────────────────────

interface ManifestDefinition {
  name: string
  category: string
  icon: string
  dataPattern: string
  readsCoreTables?: string[]
  hasOwnData?: boolean
  description: string
  longDescription: string
  quickAction?: {
    label: string
    description: string
    icon: string
    href?: string
    event?: string
    order?: number
  }
  subscriptionNotice?: string
}

interface Manifest {
  id: string
  sector: string
  exportName: string | null
  entryPoint: string | null
  workspace: string | null
  requiredEnvVars: string[]
  optionalEnvVars: string[]
  npmDependencies: string[]
  definition: ManifestDefinition
}

interface Config {
  extensions: string[]
}

// ── Helpers ──────────────────────────────────────────────────

function findManifests(dir: string): string[] {
  const results: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findManifests(fullPath))
    } else if (entry.name === 'manifest.json') {
      results.push(fullPath)
    }
  }
  return results
}

function loadAllManifests(): Map<string, Manifest> {
  const manifestPaths = findManifests(EXTENSIONS_DIR)
  const map = new Map<string, Manifest>()
  for (const mp of manifestPaths) {
    const manifest: Manifest = JSON.parse(fs.readFileSync(mp, 'utf-8'))
    if (map.has(manifest.id)) {
      console.error(`ERROR: Duplicate extension ID "${manifest.id}" found in:\n  ${mp}\n  (already defined elsewhere)`)
      process.exit(1)
    }
    map.set(manifest.id, manifest)
  }
  return map
}

function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn('Warning: extensions.config.json not found, using empty config')
    return { extensions: [] }
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
}

// ── Generators ───────────────────────────────────────────────

function generateExtensionList(manifests: Manifest[]): string {
  const withRuntime = manifests.filter(m => m.exportName && m.entryPoint)

  const imports = withRuntime.map(
    m => `import { ${m.exportName} } from '${m.entryPoint}'`
  )

  const entries = withRuntime.map(m => `  ${m.exportName},`)

  return [
    `// AUTO-GENERATED: do not edit. Run \`npm run setup:extensions\` to regenerate.`,
    `import type { Extension } from '../types'`,
    ...imports,
    ``,
    `export const FIRST_PARTY_EXTENSIONS: Extension[] = [`,
    ...entries,
    `]`,
    ``,
  ].join('\n')
}

function generateEnabledExtensions(manifests: Manifest[]): string {
  const ids = manifests.map(m => `  '${m.id}',`)

  return [
    `// AUTO-GENERATED: do not edit. Run \`npm run setup:extensions\` to regenerate.`,
    ``,
    `export const ENABLED_EXTENSION_IDS: ReadonlySet<string> = new Set([`,
    ...ids,
    `])`,
    ``,
  ].join('\n')
}

// ── Env var check ────────────────────────────────────────────

function checkEnvVars(manifests: Manifest[]): void {
  const warnings: string[] = []
  for (const m of manifests) {
    for (const envVar of m.requiredEnvVars) {
      if (!process.env[envVar]) {
        warnings.push(`  ${envVar} (required by ${m.id})`)
      }
    }
  }
  if (warnings.length > 0) {
    console.warn('\nWarning: Missing environment variables:')
    for (const w of warnings) {
      console.warn(w)
    }
    console.warn('Extensions will be loaded but may not function correctly.\n')
  }
}

// ── Main ─────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2)
  const allManifests = loadAllManifests()

  // --list mode: print all available extensions
  if (args.includes('--list')) {
    console.log('\nAvailable extensions:\n')
    const sorted = [...allManifests.values()].sort((a, b) => {
      if (a.sector !== b.sector) return a.sector.localeCompare(b.sector)
      return a.id.localeCompare(b.id)
    })
    let currentSector = ''
    for (const m of sorted) {
      if (m.sector !== currentSector) {
        currentSector = m.sector
        console.log(`\n  [${currentSector}]`)
      }
      const envNote = m.requiredEnvVars.length > 0
        ? ` (requires: ${m.requiredEnvVars.join(', ')})`
        : ''
      console.log(`    ${m.id.padEnd(25)} ${m.definition.name}${envNote}`)
    }
    console.log('')
    return
  }

  // Normal mode: generate registry files
  const config = loadConfig()

  // Validate enabled IDs
  for (const id of config.extensions) {
    if (!allManifests.has(id)) {
      console.error(`ERROR: Unknown extension ID "${id}" in extensions.config.json`)
      console.error(`Available IDs: ${[...allManifests.keys()].sort().join(', ')}`)
      process.exit(1)
    }
  }

  const enabledManifests = config.extensions.map(id => allManifests.get(id)!)

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Generate files
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'extension-list.ts'),
    generateExtensionList(enabledManifests),
  )
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'enabled-extensions.ts'),
    generateEnabledExtensions(enabledManifests),
  )

  // Summary
  const enabledNames = enabledManifests.map(m => m.id)
  if (enabledNames.length > 0) {
    console.log(`Enabled: ${enabledNames.join(', ')}`)
  } else {
    console.log('No extensions enabled (core-only mode)')
  }

  // Check env vars
  checkEnvVars(enabledManifests)
}

main()
