import { TESTED_DSH_BASELINE } from './upstream/compatibility.js'
import type { Locale } from './i18n.js'

export type CapabilityAvailability = 'available' | 'unavailable' | 'requires-upstream'

/**
 * Audited public M7.4 boundary. These names are also compile-time checked
 * against the root-exported HarnessSdkRequestMap/NotificationMap in the test
 * suite and probed against the real pinned server wire. A future upstream
 * version must land as a separate compatibility batch before this can change.
 */
export const M7_UPSTREAM_GATE = Object.freeze({
  auditedAt: '2026-08-26',
  sdkPackageVersion: TESTED_DSH_BASELINE.sdkVersion,
  wireProtocolVersion: TESTED_DSH_BASELINE.protocolVersion,
  clientRequestMethods: ['initialize', 'session/prompt', 'shutdown'] as const,
  serverNotificationMethods: [
    'session.event',
    'session.status',
    'subagent.started',
    'subagent.finished',
  ] as const,
  versionedExtensionRouter: false,
  capabilitiesHandshake: false,
  approvalAnswerer: false,
  contextCapacityHandshake: false,
  assembledPromptInspection: false,
  sessionResume: false,
})

export interface CapabilityEntry {
  id: 'history.reader' | 'bridge.protocol' | 'approval.answerer' | 'context.capacity' | 'prompt.runtime-inspection'
  availability: CapabilityAvailability
  detail: string
}

export interface CapabilityMatrixOptions {
  historyReaderAvailable: boolean
  contextCapacityObserved?: boolean
  locale?: Locale
}

export function capabilityMatrix(options: CapabilityMatrixOptions): readonly CapabilityEntry[] {
  const entries: CapabilityEntry[] = [
    {
      id: 'history.reader',
      availability: options.historyReaderAvailable ? 'available' : 'unavailable',
      detail: options.historyReaderAvailable
        ? 'Public JSONL listSnapshots/inspect reader; read-only and workspace-scoped by default.'
        : 'No read-only history source was attached to this terminal product.',
    },
    {
      id: 'bridge.protocol',
      availability: 'requires-upstream',
      detail: `Audited ${M7_UPSTREAM_GATE.auditedAt}: protocol ${M7_UPSTREAM_GATE.wireProtocolVersion} has a closed request router; dshc does not add private methods or fork the server.`,
    },
    {
      id: 'approval.answerer',
      availability: 'requires-upstream',
      detail: 'No server-to-client approval request flow or answerer handshake is exported; policy remains fail-closed.',
    },
    {
      id: 'context.capacity',
      availability: options.contextCapacityObserved === true ? 'available' : 'requires-upstream',
      detail: options.contextCapacityObserved === true
        ? 'Observed from a public request/context session event for this session.'
        : 'Unavailable until a request/context event advertises contextWindow or an upstream capability handshake exists.',
    },
    {
      id: 'prompt.runtime-inspection',
      availability: 'requires-upstream',
      detail: 'The current transport does not publish the final assembled prompt sections/tools metadata.',
    },
  ]
  if (options.locale !== 'zh-CN') return entries
  const descriptions: Record<CapabilityEntry['id'], string> = {
    'history.reader': options.historyReaderAvailable ? '通过公共 JSONL 接口只读查看历史，默认仅当前工作区。' : '当前终端未连接历史读取接口。',
    'bridge.protocol': '已验证的 SDK 使用固定请求路由，未增加私有方法或分叉服务器。',
    'approval.answerer': '上游未提供审批回答握手；终端无法授权，保持拒绝策略。',
    'context.capacity': options.contextCapacityObserved ? '已从当前会话的公共 request/context 事件观察到容量。' : '尚未观察到公共 contextWindow 容量字段。',
    'prompt.runtime-inspection': '上游未提供最终组装的提示词与工具结构检查接口。',
  }
  return entries.map(entry => ({ ...entry, detail: descriptions[entry.id] }))
}
