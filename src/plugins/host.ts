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
  private readonly views = new Map<string, OwnedView>()
  private readonly statusSegments: OwnedStatus[] = []
  private registrationOrder = 0

  register(plugin: TerminalPluginSpec): void {
    if (plugin.apiVersion !== TERMINAL_PLUGIN_API_VERSION) {
      throw new Error(`Terminal plugin ${plugin.id} targets unsupported API ${plugin.apiVersion}.`)
    }
    if (this.plugins.has(plugin.id)) throw new Error(`Duplicate terminal plugin id: ${plugin.id}`)

    for (const command of plugin.commands ?? []) this.assertCommandAvailable(plugin.id, command)
    for (const view of plugin.views ?? []) {
      if (this.views.has(view.id)) throw new Error(`Duplicate terminal view id: ${view.id}`)
    }

    this.plugins.set(plugin.id, plugin)
    for (const command of plugin.commands ?? []) this.addCommand(plugin.id, command)
    for (const renderer of plugin.eventRenderers ?? []) {
      this.renderers.push({ pluginId: plugin.id, spec: renderer, order: this.registrationOrder++ })
    }
    for (const view of plugin.views ?? []) this.views.set(view.id, { pluginId: plugin.id, spec: view })
    for (const segment of plugin.statusSegments ?? []) {
      this.statusSegments.push({ pluginId: plugin.id, spec: segment, order: this.registrationOrder++ })
    }
    this.renderers.sort(comparePriority)
    this.statusSegments.sort(comparePriority)
  }

  resolveCommand(name: string): TerminalCommandSpec | undefined {
    return this.commands.get(normalizeName(name))?.spec
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

  private assertCommandAvailable(pluginId: string, command: TerminalCommandSpec): void {
    const names = [command.name, ...(command.aliases ?? [])].map(normalizeName)
    if (new Set(names).size !== names.length) throw new Error(`Command ${command.name} repeats one of its own names.`)
    for (const name of names) {
      const owner = this.commands.get(name)
      if (owner !== undefined) throw new Error(`Terminal command /${name} from ${pluginId} conflicts with ${owner.pluginId}.`)
    }
  }

  private addCommand(pluginId: string, spec: TerminalCommandSpec): void {
    const owned = { pluginId, spec }
    const canonical = normalizeName(spec.name)
    this.canonicalCommands.set(canonical, owned)
    this.commands.set(canonical, owned)
    for (const alias of spec.aliases ?? []) this.commands.set(normalizeName(alias), owned)
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
