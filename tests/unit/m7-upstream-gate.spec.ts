import type {
  HarnessSdkNotificationMap,
  HarnessSdkRequestMap,
  InitializeResult,
} from '@deepseek-ai/dsh-sdk-protocol'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { M7_UPSTREAM_GATE, capabilityMatrix } from '../../src/capabilities.js'

describe('M7.4 published upstream compatibility gate', () => {
  it('is compile-time exhaustive over the root-exported rc.2 wire maps', () => {
    expectTypeOf<keyof HarnessSdkRequestMap>()
      .toEqualTypeOf<'initialize' | 'session/prompt' | 'shutdown'>()
    expectTypeOf<keyof HarnessSdkNotificationMap>()
      .toEqualTypeOf<'session.event' | 'session.status' | 'subagent.started' | 'subagent.finished'>()
    expectTypeOf<keyof InitializeResult>().toEqualTypeOf<'serverInfo'>()

    const requests: readonly (keyof HarnessSdkRequestMap)[] = M7_UPSTREAM_GATE.clientRequestMethods
    const notifications: readonly (keyof HarnessSdkNotificationMap)[] = M7_UPSTREAM_GATE.serverNotificationMethods
    expect(requests).toEqual(['initialize', 'session/prompt', 'shutdown'])
    expect(notifications).toEqual([
      'session.event',
      'session.status',
      'subagent.started',
      'subagent.finished',
    ])
  })

  it('keeps every M7.5 authority-bearing feature requires-upstream', () => {
    expect(M7_UPSTREAM_GATE).toMatchObject({
      sdkPackageVersion: '0.1.1-rc.2',
      wireProtocolVersion: '0.0.1',
      versionedExtensionRouter: false,
      capabilitiesHandshake: false,
      approvalAnswerer: false,
      assembledPromptInspection: false,
      sessionResume: false,
    })
    const matrix = capabilityMatrix({ historyReaderAvailable: true })
    expect(matrix.find(item => item.id === 'bridge.protocol')?.availability).toBe('requires-upstream')
    expect(matrix.find(item => item.id === 'approval.answerer')?.availability).toBe('requires-upstream')
    expect(matrix.find(item => item.id === 'prompt.runtime-inspection')?.availability).toBe('requires-upstream')
  })
})
