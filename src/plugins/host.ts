import {
  TERMINAL_PLUGIN_API_VERSION,
  type RegisteredCommandInfo,
  type RegisteredPluginInfo,
  type RegisteredRendererInfo,
  type TerminalCommandSpec,
  type TerminalEventRendererSpec,
  type TerminalPluginSpec,
  type TerminalStatusSegmentSpec,
  type TerminalViewSpec,
} from './api.js'

interface OwnedCommand { pluginId: string; spec: TerminalCommandSpec }
interface OwnedRenderer { pluginId: string; spec: TerminalEventRendererSpec; order: number }
interface OwnedView { pluginId: string; spec: TerminalViewSpec }
interface OwnedStatus { pluginId: string; spec: TerminalStatusSegmentSpec; order: number }

export class TerminalPluginHost {
  private readonly plugins = new Map<string, TerminalPluginSpec>()
  private readonly commands = new Map<string, OwnedCommand>()
  private readonly canonicalCommands = new Map<string, OwnedCommand>()
  private readonly renderers: OwnedRenderer[] = []
  private readonly rendererOwners = new Map<string, string>()
  private readonly views = new Map<string, OwnedView>()
  private readonly statusSegments: OwnedStatus[] = []
  private readonly statusOwners = new Map<string, string>()
  private registrationOrder = 0

  register(plugin: TerminalPluginSpec): void {
    if (plugin.apiVersion !== TERMINAL_PLUGIN_API_VERSION) {
      throw new Error(`Terminal plugin ${plugin.id} targets unsupported API ${plugin.apiVersion}.`)
    }
    if (this.plugins.has(plugin.id)) throw new Error(`Duplicate terminal plugin id: ${plugin.id}`)

    // Preflight the entire incoming plugin before mutating any registry. This
    // catches conflicts both against the host and inside one plugin spec.
    const commandNames = new Set<string>()
    const canonicalNames = new Set<string>()
    for (const command of plugin.commands ?? []) {
      const canonical = normalizeName(command.name)
      if (canonicalNames.has(canonical)) {
        throw new Error(`Terminal plugin ${plugin.id} repeats command /${canonical}.`)
      }
      canonicalNames.add(canonical)
      for (const rawName of [command.name, ...(command.aliases ?? [])]) {
        const name = normalizeName(rawName)
        if (commandNames.has(name)) {
          throw new Error(`Terminal plugin ${plugin.id} repeats command or alias /${name}.`)
        }
        commandNames.add(name)
        const owner = this.commands.get(name)
        if (owner !== undefined) {
          throw new Error(`Terminal command /${name} from ${plugin.id} conflicts with ${owner.pluginId}.`)
        }
      }
    }

    const viewIds = new Set<string>()
    for (const view of plugin.views ?? []) {
      if (viewIds.has(view.id)) throw new Error(`Terminal plugin ${plugin.id} repeats view id: ${view.id}`)
      viewIds.add(view.id)
      const owner = this.views.get(view.id)
      if (owner !== undefined) throw new Error(`Terminal view ${view.id} from ${plugin.id} conflicts with ${owner.pluginId}.`)
    }

    const rendererIds = new Set<string>()
    for (const renderer of plugin.eventRenderers ?? []) {
      if (rendererIds.has(renderer.id)) throw new Error(`Terminal plugin ${plugin.id} repeats renderer id: ${renderer.id}`)
      rendererIds.add(renderer.id)
      const owner = this.rendererOwners.get(renderer.id)
      if (owner !== undefined) throw new Error(`Terminal renderer ${renderer.id} from ${plugin.id} conflicts with ${owner}.`)
    }

    const statusIds = new Set<string>()
    for (const segment of plugin.statusSegments ?? []) {
      if (statusIds.has(segment.id)) throw new Error(`Terminal plugin ${plugin.id} repeats status id: ${segment.id}`)
      statusIds.add(segment.id)
      const owner = this.statusOwners.get(segment.id)
      if (owner !== undefined) throw new Error(`Terminal status ${segment.id} from ${plugin.id} conflicts with ${owner}.`)
    }

    this.plugins.set(plugin.id, plugin)
    for (const command of plugin.commands ?? []) this.addCommand(plugin.id, command)
    for (const renderer of plugin.eventRenderers ?? []) {
      this.rendererOwners.set(renderer.id, plugin.id)
      this.renderers.push({ pluginId: plugin.id, spec: renderer, order: this.registrationOrder++ })
    }
    for (const view of plugin.views ?? []) this.views.set(view.id, { pluginId: plugin.id, spec: view })
    for (const segment of plugin.statusSegments ?? []) {
      this.statusOwners.set(segment.id, plugin.id)
      this.statusSegments.push({ pluginId: plugin.id, spec: segment, order: this.registrationOrder++ })
    }
    this.renderers.sort(comparePriority)
    this.statusSegments.sort(comparePriority)
  }

  resolveCommand(name: string): TerminalCommandSpec | undefined {
    const normalized = tryNormalizeName(name)
    return normalized === undefined ? undefined : this.commands.get(normalized)?.spec
  }

  resolveView(id: string): TerminalViewSpec | undefined {
    return this.views.get(id)?.spec
  }

  matchingRenderer(event: Parameters<TerminalEventRendererSpec['match']>[0]): TerminalEventRendererSpec | undefined {
    return this.renderers.find(item => item.spec.match(event))?.spec
  }

  orderedStatusSegments(): readonly TerminalStatusSegmentSpec[] {
    return this.statusSegments.map(item => item.spec)
  }

  listPlugins(): readonly RegisteredPluginInfo[] {
    return [...this.plugins.values()]
      .map(plugin => ({ id: plugin.id, version: plugin.version }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  listCommands(): readonly RegisteredCommandInfo[] {
    return [...this.canonicalCommands.entries()]
      .map(([name, item]) => ({
        name,
        aliases: (item.spec.aliases ?? []).map(normalizeName),
        summary: item.spec.summary,
        ...(item.spec.usage === undefined ? {} : { usage: item.spec.usage }),
        pluginId: item.pluginId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  listRenderers(): readonly RegisteredRendererInfo[] {
    return this.renderers.map(item => ({
      id: item.spec.id,
      priority: item.spec.priority ?? 0,
      pluginId: item.pluginId,
    }))
  }

  private addCommand(pluginId: string, spec: TerminalCommandSpec): void {
    const owned = { pluginId, spec }
    const canonical = normalizeName(spec.name)
    this.canonicalCommands.set(canonical, owned)
    this.commands.set(canonical, owned)
    for (const alias of spec.aliases ?? []) this.commands.set(normalizeName(alias), owned)
  }
}

function tryNormalizeName(value: string): string | undefined {
  try {
    return normalizeName(value)
  } catch {
    return undefined
  }
}

function normalizeName(value: string): string {
  const normalized = value.trim().replace(/^\//, '').toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) throw new Error(`Invalid terminal registry name: ${value}`)
  return normalized
}

function comparePriority<T extends { spec: { priority?: number }; order: number }>(a: T, b: T): number {
  const priority = (b.spec.priority ?? 0) - (a.spec.priority ?? 0)
  return priority === 0 ? a.order - b.order : priority
}
