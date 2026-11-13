import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/haptics', () => ({ $hapticsMuted: { get: vi.fn(() => false) } }))
vi.mock('@/hermes', () => ({
  getHermesConfigRecord: vi.fn(async () => ({})),
  saveHermesConfig: vi.fn(async () => undefined)
}))

import { getAudioContext } from '@/lib/audio-context'
import { $hapticsMuted } from '@/store/haptics'
import { $beepVolume, $thinkingSoundEnabled } from '@/store/voice-prefs'

import { isThinkingSoundActive, startThinkingSound, stopThinkingSound } from './thinking-sound'

class FakeOscillator {
  type = 'sine'
  frequency = { exponentialRampToValueAtTime: vi.fn(), setValueAtTime: vi.fn() }
  connect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}

class FakeGain {
  gain = { exponentialRampToValueAtTime: vi.fn(), setValueAtTime: vi.fn() }
  connect = vi.fn()
}

const started: FakeOscillator[] = []
const gains: FakeGain[] = []

class FakeAudioContext {
  currentTime = 0
  destination = {}
  state = 'running'

  createOscillator() {
    const osc = new FakeOscillator()

    started.push(osc)

    return osc
  }

  createGain() {
    const gain = new FakeGain()

    gains.push(gain)

    return gain
  }

  resume() {
    return Promise.resolve()
  }
}

describe('thinking-sound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    started.length = 0
    gains.length = 0
    $thinkingSoundEnabled.set(true)
    $beepVolume.set(0.3)
    vi.mocked($hapticsMuted.get).mockReturnValue(false)
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })

  afterEach(() => {
    stopThinkingSound()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('plays repeating blips while active and stops instantly', () => {
    startThinkingSound()
    expect(isThinkingSoundActive()).toBe(true)

    vi.advanceTimersByTime(5_000)
    expect(started.length).toBeGreaterThanOrEqual(3)

    const count = started.length

    stopThinkingSound()
    expect(isThinkingSoundActive()).toBe(false)
    vi.advanceTimersByTime(5_000)
    expect(started.length).toBe(count) // nothing after stop
  })

  it('respects the voice.thinking_sound config gate', () => {
    $thinkingSoundEnabled.set(false)
    startThinkingSound()
    expect(isThinkingSoundActive()).toBe(false)
    vi.advanceTimersByTime(3_000)
    expect(started.length).toBe(0)
  })

  it('stays silent while sounds are muted but keeps the loop alive', () => {
    vi.mocked($hapticsMuted.get).mockReturnValue(true)
    startThinkingSound()
    vi.advanceTimersByTime(3_000)
    expect(started.length).toBe(0)

    // Unmute mid-loop → blips resume without a restart.
    vi.mocked($hapticsMuted.get).mockReturnValue(false)
    vi.advanceTimersByTime(3_000)
    expect(started.length).toBeGreaterThan(0)
  })

  it('start is idempotent', () => {
    startThinkingSound()
    startThinkingSound()
    vi.advanceTimersByTime(1_300)

    // One loop: at most ~2 blips in 1.3s (first at 400ms, next ≥800ms later).
    expect(started.length).toBeLessThanOrEqual(2)
  })

  it('never throws when WebAudio is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined)
    expect(() => {
      startThinkingSound()
      vi.advanceTimersByTime(2_000)
    }).not.toThrow()
    stopThinkingSound()
  })

  // The owner never heard the old 0.08 peak on speakers. Peak is now
  // 0.1 + 0.4 × voice.beep_volume: 0.22 at the backend default 0.3.
  const peakOfFirstBlip = () => {
    startThinkingSound()
    vi.advanceTimersByTime(1_000)

    return gains[0]?.gain.exponentialRampToValueAtTime.mock.calls[0]?.[0] as number | undefined
  }

  it('peaks at least 0.2 at the default voice.beep_volume', () => {
    expect(peakOfFirstBlip()).toBeGreaterThanOrEqual(0.2)
  })

  it('scales the peak with voice.beep_volume', () => {
    $beepVolume.set(1)
    expect(peakOfFirstBlip()).toBeCloseTo(0.5, 5)
  })

  it('plays nothing when voice.beep_volume is 0 (explicit silence)', () => {
    $beepVolume.set(0)
    startThinkingSound()
    vi.advanceTimersByTime(3_000)
    expect(started.length).toBe(0)
  })

  it('logs one debug line when sounds are muted, not one per blip', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    vi.mocked($hapticsMuted.get).mockReturnValue(true)
    startThinkingSound()
    vi.advanceTimersByTime(6_000)

    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0][0])).toMatch(/thinking-sound.*muted/i)
    debug.mockRestore()
  })

  it('resumes a suspended AudioContext on the next user gesture and reports the state', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const resume = vi.spyOn(FakeAudioContext.prototype, 'resume')

    // The shared context is a module singleton: suspend the live instance.
    Object.assign(getAudioContext() as object, { state: 'suspended' })

    startThinkingSound()
    vi.advanceTimersByTime(1_000)

    expect(String(debug.mock.calls.at(-1)?.[0])).toMatch(/thinking-sound.*suspended/i)

    resume.mockClear()
    window.dispatchEvent(new Event('pointerdown'))
    expect(resume).toHaveBeenCalledTimes(1)

    // One-shot: a second gesture does not resume again.
    window.dispatchEvent(new Event('pointerdown'))
    expect(resume).toHaveBeenCalledTimes(1)
    Object.assign(getAudioContext() as object, { state: 'running' })
    debug.mockRestore()
    resume.mockRestore()
  })
})
