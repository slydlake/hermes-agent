// Ambient "thinking" sound for the desktop voice conversation. While the agent
// works (status === 'thinking') no audio flows, which reads as "it died" during
// long thinking/tool stretches. A calm, repeating pair of soft bubble blips
// fills the gap — same WebAudio oscillator synthesis approach as
// wake-sound.ts / completion-sound.ts (no asset to ship), mirroring the
// backend's numpy-synthesized blips in tools/voice_mode.py so CLI and desktop
// sound alike.
//
// Honours the shared sound-mute toggle ($hapticsMuted), the
// voice.thinking_sound config gate ($thinkingSoundEnabled) and scales with
// voice.beep_volume ($beepVolume). Stops instantly on stopThinkingSound() —
// callers fire it the moment TTS starts, the mic re-arms, or the conversation
// ends.
//
// Both silent failure modes (muted, AudioContext suspended by the autoplay
// policy) log ONE debug line per start so "I heard nothing" is explainable.

import { getAudioContext } from '@/lib/audio-context'
import { $hapticsMuted } from '@/store/haptics'
import { $beepVolume, $thinkingSoundEnabled } from '@/store/voice-prefs'

let timer: number | null = null
let blipIndex = 0
let loggedMuted = false
let loggedSuspended = false

// Peak gain = BASE + SCALE × voice.beep_volume → 0.22 at the default 0.3 and
// 0.5 at most. The old fixed 0.08 was inaudible on speakers.
const PEAK_BASE = 0.1
const PEAK_SCALE = 0.4

const peakGain = (volume: number) => PEAK_BASE + PEAK_SCALE * volume

// One soft "blub": short sine with a gentle downward pitch glide and a smooth
// attack into an exponential decay — no clicks.
function blub(ac: AudioContext, freq: number, peak: number) {
  const t0 = ac.currentTime + 0.01
  const dur = 0.16
  const osc = ac.createOscillator()
  const env = ac.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, t0)
  osc.frequency.exponentialRampToValueAtTime(freq * 0.72, t0 + dur)

  env.gain.setValueAtTime(0.0001, t0)
  env.gain.exponentialRampToValueAtTime(peak, t0 + 0.02)
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

  osc.connect(env)
  env.connect(ac.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
}

// Autoplay policy keeps a context suspended until a user gesture; the resume()
// inside getAudioContext() runs without one and fails silently. Retry once, on
// the next gesture.
function resumeOnNextGesture(ac: AudioContext) {
  const events = ['pointerdown', 'keydown'] as const

  const resume = () => {
    events.forEach(name => window.removeEventListener(name, resume, true))
    void ac.resume().catch(() => undefined)
  }

  events.forEach(name => window.addEventListener(name, resume, true))
}

export function isThinkingSoundActive(): boolean {
  return timer !== null
}

/** Start the repeating thinking blips (idempotent). Best-effort, never throws. */
export function startThinkingSound(): void {
  if (timer !== null || !$thinkingSoundEnabled.get()) {
    return
  }

  loggedMuted = false
  loggedSuspended = false

  const tick = () => {
    const volume = $beepVolume.get()

    if ($hapticsMuted.get()) {
      if (!loggedMuted) {
        loggedMuted = true
        console.debug('[thinking-sound] silent: UI sounds are muted (Settings > Notifications)')
      }
    } else if (volume > 0) {
      const ac = getAudioContext()

      if (ac) {
        if (ac.state === 'suspended' && !loggedSuspended) {
          loggedSuspended = true
          console.debug(`[thinking-sound] AudioContext is ${ac.state}; resuming on the next user gesture`)
          resumeOnNextGesture(ac)
        }

        try {
          // Alternate two calm pitches (G4 / E4), matching the backend blips.
          blub(ac, blipIndex % 2 === 0 ? 392 : 329.6, peakGain(volume))
        } catch {
          // Audio backend unavailable — stay silent, keep the loop harmless.
        }
      }
    }

    blipIndex += 1
    // ~0.8-1.2s spacing with slight randomization so it reads organic.
    timer = window.setTimeout(tick, 800 + Math.random() * 400)
  }

  timer = window.setTimeout(tick, 400)
}

/** Stop the thinking blips instantly (idempotent). */
export function stopThinkingSound(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}
