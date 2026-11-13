import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $toolAckEnabled } from '@/store/voice-prefs'

import type { MicRecording } from './use-mic-recorder'
import { TOOL_ACK_PHRASES, useVoiceConversation } from './use-voice-conversation'

// While a voice turn works on tools nothing is audible (status 'thinking').
// The chained loop speaks ONE short acknowledgement per turn the moment the
// first tool starts, through playSpeechText(syncOnly) so barge-in still works.

vi.mock('@/lib/voice-barge-in', () => ({ monitorSpeechDuringPlayback: () => vi.fn() }))

const playSpeechTextMock = vi.fn(async (..._args: unknown[]) => true)

vi.mock('@/lib/voice-playback', () => ({
  markVoicePlaybackInterrupted: vi.fn(),
  playSpeechText: (...args: unknown[]) => playSpeechTextMock(...args),
  startSpeechStream: vi.fn(async () => null),
  stopVoicePlayback: vi.fn(),
  takeVoicePlaybackInterrupted: vi.fn(() => false)
}))

vi.mock('@/lib/thinking-sound', () => ({ startThinkingSound: vi.fn(), stopThinkingSound: vi.fn() }))

const micHandle = {
  cancel: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn<() => Promise<MicRecording | null>>(async () => null)
}

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: () => ({ handle: micHandle, level: 0, recording: false })
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      notifications: {
        voice: {
          configureSpeechToText: '',
          couldNotStartSession: '',
          microphoneFailed: '',
          playbackFailed: '',
          transcriptionFailed: '',
          unavailable: ''
        }
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

let toolLabel: null | string = null

function renderConversation({ enabled = true }: { enabled?: boolean } = {}) {
  // Mirrors the real app: submitting a turn makes the agent busy.
  const setBusy: { current: (busy: boolean) => void } = { current: () => undefined }

  const hook = renderHook(
    ({ busy }: { busy: boolean }) =>
      useVoiceConversation({
        activeToolLabel: () => toolLabel,
        busy,
        consumePendingResponse: vi.fn(),
        enabled,
        onSubmit: async () => setBusy.current(true),
        onTranscribeAudio: async () => 'check the server',
        pendingResponse: () => null
      }),
    { initialProps: { busy: false } }
  )

  setBusy.current = busy => hook.rerender({ busy })

  return hook
}

/** Speak one utterance: listening → transcribe → submit → status 'thinking'. */
async function submitTurn(hook: ReturnType<typeof renderConversation>) {
  await waitFor(() => expect(hook.result.current.status).toBe('listening'))
  micHandle.stop.mockResolvedValueOnce({
    audio: new Blob(['q'], { type: 'audio/webm' }),
    durationMs: 900,
    heardSpeech: true
  })
  await act(async () => {
    hook.result.current.stopTurn()
  })
  await waitFor(() => expect(hook.result.current.status).toBe('thinking'))
}

const toolStarts = (label: null | string) =>
  act(async () => {
    toolLabel = label
    await new Promise(resolve => setTimeout(resolve, 450)) // > two 200 ms polls
  })

describe('useVoiceConversation spoken tool acknowledgement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toolLabel = null
    $toolAckEnabled.set(true)
    micHandle.start.mockResolvedValue(undefined)
    micHandle.stop.mockResolvedValue(null)
  })

  afterEach(cleanup)

  it('says one German phrase through playSpeechText(syncOnly) when the first tool starts', async () => {
    const hook = renderConversation()

    await act(async () => {
      await hook.result.current.start()
    })
    await submitTurn(hook)
    expect(playSpeechTextMock).not.toHaveBeenCalled() // thinking alone is not an ack

    await toolStarts('terminal')

    expect(playSpeechTextMock).toHaveBeenCalledTimes(1)

    const [text, options] = playSpeechTextMock.mock.calls[0] as [string, Record<string, unknown>]

    expect(TOOL_ACK_PHRASES).toContain(text)
    expect(options).toMatchObject({ source: 'voice-conversation', syncOnly: true })
  })

  it('stays at one ack per turn however many tool calls follow', async () => {
    const hook = renderConversation()

    await act(async () => {
      await hook.result.current.start()
    })
    await submitTurn(hook)

    for (const label of ['terminal', null, 'web_search', 'read_file', null, 'terminal']) {
      await toolStarts(label)
    }

    expect(playSpeechTextMock).toHaveBeenCalledTimes(1)
  })

  it('acknowledges again in the next turn', async () => {
    const hook = renderConversation()

    await act(async () => {
      await hook.result.current.start()
    })
    await submitTurn(hook)
    await toolStarts('terminal')
    expect(playSpeechTextMock).toHaveBeenCalledTimes(1)

    // Turn ends without a speakable reply → loop re-arms the mic.
    toolLabel = null
    hook.rerender({ busy: false })
    await submitTurn(hook)
    await toolStarts('web_search')

    expect(playSpeechTextMock).toHaveBeenCalledTimes(2)
  })

  it('stays quiet when voice.tool_ack is false', async () => {
    $toolAckEnabled.set(false)

    const hook = renderConversation()

    await act(async () => {
      await hook.result.current.start()
    })
    await submitTurn(hook)
    await toolStarts('terminal')

    expect(playSpeechTextMock).not.toHaveBeenCalled()
  })

  it('stays quiet outside a voice conversation (text chat)', async () => {
    renderConversation({ enabled: false })
    await toolStarts('terminal')

    expect(playSpeechTextMock).not.toHaveBeenCalled()
  })
})
