// Streaming TTS sanitize contract (voice.client_direct): every sentence the
// client-direct session emits must pass sanitizeTextForSpeech BEFORE it reaches
// the provider request body — URLs, code fences, IPv4 addresses and markdown
// are never spoken, sentences that sanitize to nothing are dropped (never sent
// as empty input), and sentence cutting still runs on the RAW streamed text so
// constructs spanning delta boundaries are handled per emitted sentence.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $voicePlayback } from '@/store/voice-playback'

import { clearVoiceClientConfigCache, type DirectTtsConfig } from './voice-client-direct'
import { startSpeechStream, stopVoicePlayback } from './voice-playback'

const tts: DirectTtsConfig = {
  mode: 'direct',
  wire: 'openai-speech',
  provider: 'openai',
  base_url: 'https://tts.test/v1',
  api_key: 'sk-test',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  speed: null
}

// Playback completes on its own so the session queue drains: play() fires the
// 'ended' listener on the next tick, exactly like a finished audio element.
class FakeAudio {
  static instances: FakeAudio[] = []
  listeners = new Map<string, () => void>()
  src: string
  addEventListener = vi.fn((event: string, callback: () => void) => {
    this.listeners.set(event, callback)
  })
  removeEventListener = vi.fn()
  pause = vi.fn()
  play = vi.fn(() => {
    setTimeout(() => this.listeners.get('ended')?.(), 0)

    return Promise.resolve()
  })
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }
}

describe('client-direct streaming sanitizes every sentence before the provider', () => {
  let bodies: Array<Record<string, unknown>> = []
  let fetchMock: ReturnType<typeof vi.fn>
  let originalCreateObjectURL: typeof URL.createObjectURL | undefined
  let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined

  beforeEach(() => {
    clearVoiceClientConfigCache()
    bodies = []
    FakeAudio.instances = []
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)

      return new Response(new ArrayBuffer(16), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Audio', FakeAudio)
    originalCreateObjectURL = URL.createObjectURL
    originalRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:fake-audio')
    URL.revokeObjectURL = vi.fn()
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { api: vi.fn(async () => ({ ok: true, stt: { mode: 'relay' }, tts })) }
    })
    $voicePlayback.set({ audioElement: null, messageId: null, sequence: 0, source: null, status: 'idle' })
  })

  afterEach(() => {
    stopVoicePlayback()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()

    if (originalCreateObjectURL) {
      URL.createObjectURL = originalCreateObjectURL
    } else {
      delete (URL as { createObjectURL?: unknown }).createObjectURL
    }

    if (originalRevokeObjectURL) {
      URL.revokeObjectURL = originalRevokeObjectURL
    } else {
      delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
    }

    Reflect.deleteProperty(window, 'hermesDesktop')
    clearVoiceClientConfigCache()
  })

  it('URLs, code fences and IPv4 addresses never reach the TTS request body', async () => {
    const session = await startSpeechStream({ source: 'voice-conversation' })
    expect(session).not.toBeNull()

    session!.append('The dashboard is at https://pve3.local:8006/ui. ')
    session!.append('Here is code:\n```python\nprint("192.168.178.13")\n```\n')
    session!.append('The exporter listens on 192.168.178.13:9100 today. ')
    session!.append('All done.')
    session!.finish()
    await expect(session!.done).resolves.toBe('done')

    expect(bodies.length).toBeGreaterThan(0)
    const spoken = bodies.map(body => String(body.input)).join(' ')
    expect(spoken).not.toContain('```')
    expect(spoken).not.toContain('https://')
    expect(spoken).not.toContain('192.168.178.13')
    expect(spoken).not.toContain('9100')
    expect(spoken).not.toContain('print(')
    // The speakable prose around the silenced constructs survives.
    expect(spoken).toContain('The dashboard is at')
    expect(spoken).toContain('The exporter listens on today.')
    expect(spoken).toContain('All done.')

    // No empty input ever reaches the provider.
    for (const body of bodies) {
      expect(String(body.input).trim().length).toBeGreaterThan(0)
    }
  })

  it('cuts sentences on the raw stream even when a URL spans delta boundaries', async () => {
    const session = await startSpeechStream({ source: 'voice-conversation' })
    expect(session).not.toBeNull()

    session!.append('See https://example.test/very/')
    session!.append('long/path for details. All good.')
    session!.finish()
    await expect(session!.done).resolves.toBe('done')

    const spoken = bodies.map(body => String(body.input)).join(' ')
    expect(spoken).not.toContain('https://')
    expect(spoken).not.toContain('example.test')
    expect(spoken).toContain('for details.')
    expect(spoken).toContain('All good.')
  })

  it('a reply that sanitizes to nothing makes no provider call and falls back', async () => {
    const session = await startSpeechStream({ source: 'voice-conversation' })
    expect(session).not.toBeNull()

    session!.append('```python\nprint("secret")\n```')
    session!.finish()
    await expect(session!.done).resolves.toBe('fallback')

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
