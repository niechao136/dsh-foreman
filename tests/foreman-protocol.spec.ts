import { expect, it } from 'vitest'
import { FOREMAN_PROTOCOL_VERSION, encodeFrame, parseFrame } from '../src/foreman/protocol.ts'

it('the hub speaks exactly the frame the device package defines', () => {
  const frame = { v: FOREMAN_PROTOCOL_VERSION, type: 'report' as const, frameId: 'f1', assignmentId: 'a1', state: 'ready' as const, summary: 'ok' }
  expect(parseFrame(encodeFrame(frame))).toEqual(frame)
})