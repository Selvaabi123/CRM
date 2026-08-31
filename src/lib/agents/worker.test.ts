import { describe, it, expect } from 'vitest'
import type { AiAgentTool } from '@/types/ai-agents'
import { effectiveTools, parseAiPlan, isTaskReclaimable, TASK_CLAIM_STALE_MS } from './worker'

const ALLOWED: Set<AiAgentTool> = new Set(['send_whatsapp', 'manage_pipeline', 'report'])

describe('effectiveTools', () => {
  it('keeps only executor-known tools from the allow-list', () => {
    expect(effectiveTools(['report', 'send_whatsapp'])).toEqual(['report', 'send_whatsapp'])
  })

  it('drops unknown / legacy tool labels (defence in depth)', () => {
    expect(effectiveTools(['send_whatsapp', 'magic_tool', 'broadcast'])).toEqual(['send_whatsapp'])
  })

  it('returns empty for an empty or unknown allow-list', () => {
    expect(effectiveTools([])).toEqual([])
    expect(effectiveTools(['not_a_tool'])).toEqual([])
  })
})

describe('parseAiPlan', () => {
  it('parses a valid JSON tool plan', () => {
    const raw = JSON.stringify([
      { tool: 'send_whatsapp', args: { contactId: 'c1', text: 'hi' }, reason: 'follow-up' },
    ])
    const plan = parseAiPlan(raw, ALLOWED)
    expect(plan).toHaveLength(1)
    expect(plan?.[0].tool).toBe('send_whatsapp')
    expect(plan?.[0].args).toEqual({ contactId: 'c1', text: 'hi' })
    expect(plan?.[0].reason).toBe('follow-up')
  })

  it('strips markdown code fences around the JSON payload', () => {
    const raw = '```json\n[{"tool":"report","args":{"body":"x"}}]\n```'
    const plan = parseAiPlan(raw, ALLOWED)
    expect(plan).toHaveLength(1)
    expect(plan?.[0].tool).toBe('report')
  })

  it('drops steps whose tool is NOT in the allow-list', () => {
    const raw = JSON.stringify([
      { tool: 'send_broadcast', args: { text: 'spam' } },
      { tool: 'send_whatsapp', args: { text: 'ok' } },
    ])
    const plan = parseAiPlan(raw, ALLOWED)
    expect(plan).toHaveLength(1)
    expect(plan?.[0].tool).toBe('send_whatsapp')
  })

  it('drops malformed steps and unknown tool names', () => {
    const raw = JSON.stringify([
      { args: { text: 'no tool' } },
      { tool: 'totally_made_up' },
      { tool: 'report', args: { body: 'ok' } },
    ])
    const plan = parseAiPlan(raw, ALLOWED)
    expect(plan).toHaveLength(1)
    expect(plan?.[0].tool).toBe('report')
  })

  it('returns null for a non-array payload', () => {
    expect(parseAiPlan('{"tool":"report"}', ALLOWED)).toBeNull()
  })

  it('returns null for unparseable output', () => {
    expect(parseAiPlan('not json at all', ALLOWED)).toBeNull()
  })

  it('returns an empty array when the model responds with an empty list', () => {
    expect(parseAiPlan('[]', ALLOWED)).toEqual([])
  })
})

describe('isTaskReclaimable', () => {
  const now = new Date('2026-01-01T00:00:00Z').toISOString()

  it('always reclaims a todo task (not yet picked up)', () => {
    expect(isTaskReclaimable('todo', null, now)).toBe(true)
  })

  it('does not reclaim a freshly in_progress task (another runner owns it)', () => {
    const fresh = new Date('2026-01-01T00:00:01Z').toISOString()
    expect(isTaskReclaimable('in_progress', fresh, now)).toBe(false)
  })

  it('reclaims an in_progress task whose claim has gone stale (crash recovery)', () => {
    const stale = new Date(Date.parse(now) - TASK_CLAIM_STALE_MS - 1000).toISOString()
    expect(isTaskReclaimable('in_progress', stale, now)).toBe(true)
  })

  it('reclaims an in_progress task with no started_at', () => {
    expect(isTaskReclaimable('in_progress', null, now)).toBe(true)
  })

  it('never reclaims a terminal task (done / blocked / cancelled)', () => {
    for (const s of ['done', 'blocked', 'cancelled']) {
      expect(isTaskReclaimable(s, null, now)).toBe(false)
    }
  })
})
