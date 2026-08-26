import {
  buildHistoryAskPrompt,
  buildHistoryContinuePrompt,
  fingerprintHistoryAskSelection,
  parseHistorySeqs,
  renderHistoryAskReview,
  selectHistoryEvidence,
} from '../history/ask.js'
import type {
  HistoryCatalog,
  HistoryReader,
  HistorySessionDetail,
  HistorySessionSummary,
} from '../history/types.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { splitGraphemes } from '../terminal/text-metrics.js'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  TERMINAL_PLUGIN_API_VERSION,
  type TerminalCommandOutcome,
  type TerminalCommandSpec,
  type TerminalPluginSpec,
  type TerminalViewSpec,
} from './api.js'

const HISTORY_USAGE = [
  '/history',
  '/history all',
  '/history find <text>',
  '/history open <session-id> [--cross-workspace]',
  '/history ask <session-id> [all|seqs] [--cross-workspace] [--yes] -- <question>',
  '/history continue <session-id> [all|seqs] [--cross-workspace] [--yes] -- <next instruction>',
].join('\n')

type HistoryCatalogState = {
  kind: 'catalog'
  catalog: HistoryCatalog
  selected: number
  query: string
  focus: 'list' | 'search'
}

type HistoryViewState =
  | { kind: 'empty'; message: string }
  | HistoryCatalogState
  | { kind: 'detail'; detail: HistorySessionDetail; crossWorkspace: boolean; returnTo?: HistoryCatalogState }

/**
 * First-party history controller. It is deliberately not part of
 * TerminalViewSpec API v1: the product may route arrows/Enter to this instance,
 * while third-party views remain render-only and compatible.
 */
export class HistoryWorkbench {
  private pendingAskFingerprint: string | undefined
  private state: HistoryViewState = {
    kind: 'empty',
    message: 'Run /history to load the read-only Harness session catalog.',
  }

  constructor(readonly reader: HistoryReader) {}

  plugin(): TerminalPluginSpec {
    return {
      id: 'dshc.history',
      version: '1.0.0',
      apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [this.command()],
      views: [this.view()],
    }
  }

  move(delta: number): boolean {
    if (this.state.kind !== 'catalog' || this.state.focus !== 'list' || this.state.catalog.sessions.length === 0) return false
    const selected = Math.max(0, Math.min(this.state.catalog.sessions.length - 1, this.state.selected + delta))
    if (selected === this.state.selected) return false
    this.state = { ...this.state, selected }
    return true
  }

  isSearchFocused(): boolean {
    return this.state.kind === 'catalog' && this.state.focus === 'search'
  }

  toggleFocus(): boolean {
    if (this.state.kind !== 'catalog') return false
    this.state = { ...this.state, focus: this.state.focus === 'list' ? 'search' : 'list' }
    return true
  }

  insertSearch(text: string): boolean {
    if (this.state.kind !== 'catalog' || this.state.focus !== 'search' || text.length === 0) return false
    const inserted = sanitizeTerminalText(text).replace(/\s+/g, ' ')
    const query = `${this.state.query}${inserted}`.slice(0, 256)
    if (query === this.state.query) return false
    this.state = { ...this.state, query }
    return true
  }

  deleteSearch(): boolean {
    if (this.state.kind !== 'catalog' || this.state.focus !== 'search' || this.state.query.length === 0) return false
    this.state = { ...this.state, query: splitGraphemes(this.state.query).slice(0, -1).join('') }
    return true
  }

  clearSearch(): boolean {
    if (this.state.kind !== 'catalog' || this.state.focus !== 'search' || this.state.query.length === 0) return false
    this.state = { ...this.state, query: '' }
    return true
  }

  async commitSearch(): Promise<boolean> {
    if (this.state.kind !== 'catalog' || this.state.focus !== 'search') return false
    const { catalog, query } = this.state
    const next = await this.reader.list({
      workspace: catalog.workspace,
      allWorkspaces: catalog.allWorkspaces,
      ...(query.trim().length === 0 ? {} : { text: query.trim() }),
    })
    this.state = { kind: 'catalog', catalog: next, selected: 0, query: query.trim(), focus: 'list' }
    return true
  }

  async openSelected(): Promise<boolean> {
    if (this.state.kind !== 'catalog') return false
    const selected = this.state.catalog.sessions[this.state.selected]
    if (selected === undefined) return false
    const returnTo = this.state
    this.state = {
      kind: 'detail',
      detail: await this.reader.inspect(selected.id),
      crossWorkspace: returnTo.catalog.allWorkspaces,
      returnTo,
    }
    return true
  }

  back(): boolean {
    if (this.state.kind !== 'detail' || this.state.returnTo === undefined) return false
    this.state = this.state.returnTo
    return true
  }

  continuationCommand(): string | undefined {
    const selected = this.state.kind === 'detail'
      ? { id: this.state.detail.summary.id, crossWorkspace: this.state.crossWorkspace }
      : this.state.kind === 'catalog'
        ? {
            id: this.state.catalog.sessions[this.state.selected]?.id,
            crossWorkspace: this.state.catalog.allWorkspaces,
          }
        : undefined
    if (selected?.id === undefined || /\s/.test(selected.id)) return undefined
    return `/history continue ${selected.id} all${selected.crossWorkspace ? ' --cross-workspace' : ''} -- Continue from this conversation.`
  }

  render(): string {
    switch (this.state.kind) {
      case 'empty': return this.state.message
      case 'catalog': return renderCatalog(this.state.catalog, this.state.selected, this.state.query, this.state.focus)
      case 'detail': return renderDetail(this.state.detail, this.state.returnTo !== undefined)
    }
  }

  private command(): TerminalCommandSpec {
    return {
      name: 'history',
      aliases: ['sessions'],
      summary: 'Browse past conversations or continue selected evidence in a new session',
      usage: HISTORY_USAGE,
      execute: async (context, args) => this.execute(context.runtime.workspace, args),
    }
  }

  private view(): TerminalViewSpec {
    return { id: 'history', title: 'History', render: () => this.render() }
  }

  private async execute(workspace: string, args: readonly string[]): Promise<TerminalCommandOutcome> {
    const mode = args[0]?.toLowerCase()
    if (mode === 'help') return { kind: 'message', title: 'history', text: HISTORY_USAGE }
    if (mode === 'open') {
      const crossWorkspace = args[2] === '--cross-workspace'
      if (args.length < 2 || args.length > 3 || (args.length === 3 && !crossWorkspace)) {
        throw new Error('/history open requires a session id and optional --cross-workspace')
      }
      const detail = await this.reader.inspect(args[1]!)
      assertHistoryScope(detail, workspace, crossWorkspace)
      this.state = { kind: 'detail', detail, crossWorkspace }
      return { kind: 'view', viewId: 'history' }
    }
    if (mode === 'ask' || mode === 'continue') return this.handoff(workspace, args.slice(1), mode)

    const allWorkspaces = mode === 'all'
    const text = mode === 'find' ? args.slice(1).join(' ').trim() : undefined
    if (mode !== undefined && mode !== 'all' && mode !== 'find') throw new Error(`usage:\n${HISTORY_USAGE}`)
    if (mode === 'find' && text?.length === 0) throw new Error('/history find requires search text')
    const catalog = await this.reader.list({ workspace, allWorkspaces, ...(text === undefined ? {} : { text }) })
    this.state = { kind: 'catalog', catalog, selected: 0, query: text ?? '', focus: 'list' }
    return { kind: 'view', viewId: 'history' }
  }

  private async handoff(
    workspace: string,
    args: readonly string[],
    purpose: 'ask' | 'continue',
  ): Promise<TerminalCommandOutcome> {
    const command = `/history ${purpose}`
    const title = purpose === 'ask' ? 'Ask History' : 'Continue History'
    const separator = args.indexOf('--')
    if (separator < 0) throw new Error(`${command} requires -- before the ${purpose === 'ask' ? 'question' : 'next instruction'}`)
    const selector = args.slice(0, separator)
    const question = args.slice(separator + 1).join(' ').trim()
    const sessionId = selector[0]
    if (sessionId === undefined) throw new Error(`${command} requires a session id`)
    const confirmed = selector.includes('--yes')
    const crossWorkspace = selector.includes('--cross-workspace')
    const selectionArgs = selector.slice(1).filter(value => value !== '--yes' && value !== '--cross-workspace')
    if (selectionArgs.length > 1) throw new Error(`${command} accepts at most one sequence list`)
    const detail = await this.reader.inspect(sessionId)
    assertHistoryScope(detail, workspace, crossWorkspace)
    const selection = selectHistoryEvidence(detail, parseHistorySeqs(selectionArgs[0]), question, purpose)
    const review = renderHistoryAskReview(selection, purpose)
    const fingerprint = fingerprintHistoryAskSelection(selection, purpose)
    if (!confirmed) {
      this.pendingAskFingerprint = fingerprint
      return {
        kind: 'message',
        title: `${title} review`,
        text: [
          review,
          `review fingerprint: ${fingerprint.slice(0, 16)}`,
          '',
          `Nothing was sent. Re-run the same ${command} command with --yes before -- after reviewing the source list.`,
        ].join('\n'),
      }
    }
    if (this.pendingAskFingerprint === undefined) {
      throw new Error(`${title} confirmation requires a review in this terminal process; run the same command without --yes first`)
    }
    if (this.pendingAskFingerprint !== fingerprint) {
      this.pendingAskFingerprint = undefined
      throw new Error(`${title} evidence changed or the requested action differs from review; nothing was sent. Review the current evidence again before confirming`)
    }
    this.pendingAskFingerprint = undefined
    return {
      kind: 'submit-prompt',
      prompt: purpose === 'ask' ? buildHistoryAskPrompt(selection) : buildHistoryContinuePrompt(selection),
      displayText: `${title} · ${selection.messages.length} selected source${selection.messages.length === 1 ? '' : 's'}\n${question}`,
      sourceSummary: `${selection.messages.length} messages from ${sessionId}`,
      newSession: true,
    }
  }
}

function assertHistoryScope(detail: HistorySessionDetail, workspace: string, crossWorkspace: boolean): void {
  if (crossWorkspace) return
  const source = detail.summary.cwd
  if (source !== undefined && isAbsolute(source) && relative(resolve(source), resolve(workspace)).length === 0) return
  throw new Error('The source session is outside the current workspace or has no recorded workspace. Re-run with --cross-workspace to inspect or send it explicitly.')
}

function renderCatalog(
  catalog: HistoryCatalog,
  selected: number,
  query: string,
  focus: 'list' | 'search' = 'list',
): string {
  const sessions = catalog.sessions
  const radius = 7
  const start = Math.max(0, Math.min(Math.max(0, sessions.length - radius * 2 - 1), selected - radius))
  const visible = sessions.slice(start, start + radius * 2 + 1)
  const rows = visible.map((session, offset) => renderSessionRow(session, start + offset === selected))
  return [
    `source: ${catalog.root}`,
    `scope: ${catalog.allWorkspaces ? 'all workspaces (explicit)' : catalog.workspace}`,
    `sessions: ${sessions.length} shown · ${catalog.matchingSnapshots} in scope · ${catalog.totalSnapshots} total`,
    `search: ${query.length === 0 ? '(all)' : sanitizeTerminalText(query)}${focus === 'search' ? '▌' : ''} · focus=${focus}`,
    ...(catalog.omittedSnapshots === 0 ? [] : [`limit: ${catalog.omittedSnapshots} older sessions omitted from this bounded in-memory projection`]),
    ...(catalog.diagnostics.length === 0 ? [] : [`diagnostics: ${catalog.diagnostics.length} sessions degraded to metadata-only rows`]),
    '',
    ...(rows.length === 0 ? ['No sessions matched.'] : rows),
    '',
    focus === 'search'
      ? 'type to edit · Backspace delete · Ctrl+U clear · Enter search · Tab/Esc return to list'
      : '↑/↓ select · Enter inspect · c continue in new session · Tab search · Esc/q live chat',
    'True resume is unavailable on SDK protocol 0.0.1; Continue uses reviewed evidence in a NEW session.',
  ].join('\n')
}

function renderSessionRow(session: HistorySessionSummary, selected: boolean): string {
  const date = safeIso(session.updatedAt).replace('T', ' ').slice(0, 16)
  const model = session.model === undefined ? '' : ` · ${session.model}`
  const origin = session.origin === undefined ? '' : ` · ${session.origin}`
  const diagnostic = session.diagnostic === undefined ? '' : ' · partial'
  return `${selected ? '›' : ' '} ${date} · ${short(session.id)}${model}${origin}${diagnostic}\n    ${oneLine(session.title, 100)}`
}

function renderDetail(detail: HistorySessionDetail, returnsToCatalog = false): string {
  const { summary } = detail
  const messages = detail.messages.slice(-24).map(message => {
    const omitted = message.truncatedChars === 0 ? '' : ` · ${message.truncatedChars} chars omitted`
    const usage = message.usage === undefined
      ? ''
      : ` · in ${totalInput(message.usage)} out ${message.usage.outputTokens}${message.usage.cacheReadTokens === undefined ? '' : ` cache-read ${message.usage.cacheReadTokens}`}`
    return `#${message.seq} ${message.role} · ${safeIso(message.time)}${usage}${omitted}\n  ${oneLine(message.text, 160)}`
  })
  const tools = (detail.tools ?? []).slice(-12).map(tool => {
    const duration = tool.calledAt === undefined || tool.resultAt === undefined
      ? ''
      : ` · ${Math.max(0, tool.resultAt - tool.calledAt)}ms`
    const outcome = tool.resultSeq === undefined ? 'pending/unobserved' : tool.isError === true ? 'error' : 'success'
    const preview = tool.result ?? tool.arguments ?? ''
    return `#${tool.calledSeq ?? tool.resultSeq ?? '?'} ${tool.name ?? 'tool'} · ${outcome}${duration} · call ${short(tool.callId)}${preview.length === 0 ? '' : `\n  ${oneLine(preview, 140)}`}`
  })
  const approvals = detail.approvals.slice(-10).map(item => {
    if (item.phase === 'policy') return `#${item.seq} policy=${item.policy}`
    if (item.phase === 'asked') return `#${item.seq} asked ${item.toolName ?? 'unknown-tool'} id=${short(item.requestId)}`
    return `#${item.seq} decided ${item.outcome} id=${short(item.requestId)}`
  })
  return [
    summary.title,
    `session: ${summary.id}`,
    `workspace: ${summary.cwd ?? 'not recorded'}`,
    `created: ${safeIso(summary.createdAt)} · updated: ${safeIso(summary.updatedAt)}`,
    `route: ${summary.provider ?? 'unknown'}/${summary.model ?? 'unknown'} · context window: ${summary.contextWindow ?? 'not observed'}`,
    `events: ${detail.eventCount} · messages: ${summary.messageCount} · tools: ${summary.toolCallCount} · compactions: ${summary.compactionCount}`,
    ...(detail.droppedMessageCount === 0 ? [] : [`retention: ${detail.droppedMessageCount} older message projections omitted locally`]),
    ...(summary.diagnostic === undefined ? [] : [`diagnostic: ${summary.diagnostic}`]),
    '',
    'Recent message events',
    ...(messages.length === 0 ? ['(none)'] : messages),
    ...(tools.length === 0 ? [] : ['', 'Recent tool activity', ...tools]),
    ...(approvals.length === 0 ? [] : ['', 'Approval audit', ...approvals]),
    '',
    'c prepares a review-first continuation command for this conversation.',
    `${returnsToCatalog ? 'Esc/q returns to the history list.' : 'Esc/q returns to the live conversation.'}`,
    'True resume is unavailable on SDK protocol 0.0.1; Continue creates a NEW session.',
  ].join('\n')
}

function totalInput(usage: NonNullable<HistorySessionDetail['messages'][number]['usage']>): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function short(value: string): string {
  const safe = sanitizeTerminalText(value)
  return safe.length <= 18 ? safe : `${safe.slice(0, 8)}…${safe.slice(-7)}`
}

function oneLine(value: string, limit: number): string {
  const safe = sanitizeTerminalText(value).replace(/\s+/g, ' ').trim()
  return safe.length <= limit ? safe : `${safe.slice(0, limit - 3)}...`
}

function safeIso(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}
