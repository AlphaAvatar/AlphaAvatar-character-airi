<script setup lang="ts">
import { onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  Room,
  RoomEvent,
  RemoteParticipant,
  RemoteTrackPublication,
  Track,
} from 'livekit-client'

import Cross from '../components/Backgrounds/Cross.vue'
import AnimatedWave from '../components/Widgets/AnimatedWave.vue'
import { WidgetStage } from '@proj-airi/stage-ui/components/scenes'
import { useLive2d } from '@proj-airi/stage-ui/stores/live2d'
import { breakpointsTailwind, useBreakpoints, useDark } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'

// ---------- Live2D ----------
const dark = useDark()
const live2d = useLive2d()
const { scale, position, positionInPercentageString } = storeToRefs(live2d)
const breakpoints = useBreakpoints(breakpointsTailwind)

// ---------- LiveKit ----------
const route = useRoute()

const url = route.query.livekitUrl as string
const token = route.query.livekitToken as string
const agentIdentity = route.query.agentIdentity as string | undefined

const room = new Room()

let audioCtx: AudioContext | null = null
let lipsyncRAF: number | null = null
let blinkRAF: number | null = null

console.log('[AIRI] 🔥 LivekitAvatar.vue loaded at', new Date().toISOString())
console.log('[AIRI] URL =', url)
console.log('[AIRI] TOKEN length =', token?.length ?? 0)

const MODEL_ZIP_URL = '/assets/live2d/models/hiyori_pro_zh.zip'

// Prefetch Live2D model zip (especially for Playwright env)
fetch(MODEL_ZIP_URL)
  .then((res) => {
    console.log('[AIRI] prefetch live2d model zip, status =', res.status)
  })
  .catch((err) => {
    console.error('[AIRI] prefetch live2d model zip failed:', err)
  })

// ---------- Global state for audio-driven animation ----------
let lastMouth = 0
let lastSpeechLevel = 0
let speechPhase = 0

// Eye animation base (from audio) + blink factor
let baseEyeOpen = 1
let baseEyeSmile = 0
let blinkFactor = 1 // 1 = fully open, 0 = fully closed (from blink)

// ---------- Global state for blinking ----------
let blinkTimer = 0
let blinkInterval = randomBetween(2000, 6000) // ms between blinks
let blinkProgress = 0
let blinking = false
let blinkClosing = false

// ---------- Lifecycle ----------
onMounted(async () => {
  if (!url || !token) {
    console.error('[AIRI] Missing VITE_AIRI_LIVEKIT_URL or VITE_AIRI_LIVEKIT_TOKEN')
    return
  }

  try {
    console.log('[AIRI] Connecting to LiveKit:', url)
    await room.connect(url, token)
    console.log('[AIRI] Connected to LiveKit!')

    try {
      // Force preset model id if the store supports it
      ;(live2d as any).currentDisplayModelId = 'preset-live2d-1'

      if (typeof (live2d as any).loadDisplayModelsFromIndexedDB === 'function') {
        await (live2d as any).loadDisplayModelsFromIndexedDB()
      }

      if (typeof (live2d as any).ensureModelLoaded === 'function') {
        await (live2d as any).ensureModelLoaded()
      }

      console.log('[AIRI] Live2D preset model initialized')

      // Start independent blink loop once model is ready
      startBlinkLoop()
    }
    catch (e) {
      console.warn('[AIRI] Live2D preset init error', e)
    }

    // 1) Publish Live2D canvas as video track
    await publishCanvasAsVideo()

    // 2) Register track handler for audio stream
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)

    // 3) (Optional) register datapacket handler for visemes
    // room.on('dataReceived', handleDataReceived)

    // 4) Notify backend that avatar is ready
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'avatar_ready' }))
    await room.localParticipant.publishData(payload, {
      reliable: true,
      topic: 'avatar_status',
    })
    console.log('[AIRI] avatar_ready sent')
  }
  catch (e) {
    console.error('[AIRI] Failed to connect to LiveKit:', e)
  }
})

onBeforeUnmount(() => {
  if (lipsyncRAF != null)
    cancelAnimationFrame(lipsyncRAF)

  if (blinkRAF != null)
    cancelAnimationFrame(blinkRAF)

  if (audioCtx)
    audioCtx.close()

  room.disconnect()
})

// ---------- Publish Live2D canvas as video track ----------
async function publishCanvasAsVideo() {
  // Wait for WidgetStage to be rendered
  await nextTick()

  // WidgetStage root has class="airi-stage"
  const canvas = document.querySelector('.airi-stage canvas') as HTMLCanvasElement | null
  if (!canvas) {
    console.warn('[AIRI] No canvas found for WidgetStage, skip video track publish')
    return
  }

  const stream = canvas.captureStream(30) // 30fps
  const [videoTrack] = stream.getVideoTracks()

  await room.localParticipant.publishTrack(videoTrack, {
    name: 'airi-avatar',
  })

  console.log('[AIRI] Published WidgetStage canvas as video track')
}

// ---------- LiveKit audio track handler ----------
function handleTrackSubscribed(
  track: Track,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
) {
  try {
    console.log(
      '[AIRI] TrackSubscribed:',
      'kind=', track.kind,
      'identity=', participant.identity,
      'name=', publication.trackName,
    )

    if (track.kind !== 'audio')
      return

    if (agentIdentity && participant.identity !== agentIdentity) {
      console.log(
        '[AIRI] audio track identity not match, expect =',
        agentIdentity,
        'got =',
        participant.identity,
      )
      return
    }

    console.log('[AIRI] Received audio track from agent:', participant.identity)

    console.log(
      '[AIRI] track muted =',
      (track as any).isMuted,
      'readyState =',
      track.mediaStreamTrack.readyState,
    )

    const mediaStream = new MediaStream([track.mediaStreamTrack])

    // 1) Play to speakers (if environment allows)
    const audioEl = new Audio()
    audioEl.srcObject = mediaStream
    audioEl.autoplay = true
    audioEl.controls = false

    audioEl.play().then(() => {
      console.log('[AIRI] audioEl play() success')
    }).catch((e) => {
      console.warn('[AIRI] audioEl auto-play failed:', e)
    })

    // 2) Create AudioContext + Analyser
    if (!audioCtx) {
      try {
        audioCtx = new AudioContext()
        console.log('[AIRI] created AudioContext, state =', audioCtx.state)
      }
      catch (e) {
        console.error('[AIRI] create AudioContext failed:', e)
        return
      }
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume()
        .then(() => {
          console.log('[AIRI] audioCtx resumed, state =', audioCtx!.state)
        })
        .catch((e) => {
          console.warn('[AIRI] audioCtx resume failed:', e)
        })
    }

    const source = audioCtx.createMediaStreamSource(mediaStream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048

    source.connect(analyser)

    console.log('[AIRI] lipsync analyser created, fftSize =', analyser.fftSize)

    startLipsyncFromAnalyser(analyser)
  }
  catch (e) {
    console.error('[AIRI] handleTrackSubscribed error:', e)
  }
}

// ---------- Lipsync + audio-driven animation ----------
type AudioDriveParams = {
  mouthOpen: number
  speechLevel: number // 0~1, how intense the speech is
}

function startLipsyncFromAnalyser(analyser: AnalyserNode) {
  const data = new Float32Array(analyser.fftSize)

  // Noise gate & mapping params (tweak as needed)
  const NOISE_FLOOR = 0.002        // ambient noise RMS, anything below is treated as silence
  const GAIN = 18                  // volume -> mouth amplitude
  const SILENCE_THRESHOLD = 0.04   // below this, we treat as mouth closed
  const SMOOTHING = 0.2            // low-pass smoothing (0 = no smoothing, 1 = very slow)

  const loop = () => {
    analyser.getFloatTimeDomainData(data)

    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)

    const level = Math.max(0, rms - NOISE_FLOOR)
    const target = Math.min(1, level * GAIN)

    // Smooth mouth strength
    lastMouth = lastMouth * (1 - SMOOTHING) + target * SMOOTHING

    let mouthOpen: number
    if (lastMouth < SILENCE_THRESHOLD) {
      mouthOpen = 0
    } else {
      mouthOpen = (lastMouth - SILENCE_THRESHOLD) / (1 - SILENCE_THRESHOLD)
      mouthOpen = Math.min(1, Math.max(0, mouthOpen))
    }

    // Smooth speech intensity (for eyebrows / body / cheeks / etc.)
    lastSpeechLevel = lastSpeechLevel * (1 - SMOOTHING) + target * SMOOTHING
    const speechLevel = Math.min(1, Math.max(0, lastSpeechLevel))

    applyAudioToLive2D({ mouthOpen, speechLevel })

    lipsyncRAF = requestAnimationFrame(loop)
  }

  console.log('[AIRI] startLipsyncFromAnalyser')
  loop()
}

// Apply audio-driven values to Live2D parameters (mouth, cheeks, eyebrows, body, breath, eyes base)
function applyAudioToLive2D({ mouthOpen, speechLevel }: AudioDriveParams) {
  const vMouth = Math.min(1, Math.max(0, mouthOpen))
  const vSpeech = Math.min(1, Math.max(0, speechLevel))

  if (!live2d?.modelParameters)
    return

  try {
    const p = live2d.modelParameters as any

    // 1) Mouth: open + form
    p.mouthOpen = vMouth

    // More intense speech -> more mouth form (slight smile / articulation)
    if (vSpeech < 0.1) {
      p.mouthForm = 0
    } else {
      p.mouthForm = Math.min(0.6, (vSpeech - 0.1) * 0.8)
    }

    // 2) Cheeks: slightly puff / blush with intensity
    p.cheek = Math.min(0.5, vSpeech * 0.5)

    // 3) Eyes base: audio-driven squint & smile (blink is applied on top via blinkFactor)
    const eyeSquint = vSpeech * 0.3 // max reduce to ~0.7
    baseEyeOpen = 1.0 - eyeSquint
    baseEyeSmile = Math.min(0.7, vSpeech * 0.7)

    const eyeOpenValue = baseEyeOpen * blinkFactor
    p.leftEyeOpen = eyeOpenValue
    p.rightEyeOpen = eyeOpenValue
    p.leftEyeSmile = baseEyeSmile
    p.rightEyeSmile = baseEyeSmile

    // 4) Eyebrows: lift + angle + form with intensity
    const browLift = vSpeech * 0.5
    const browAngle = vSpeech * 0.3
    const browForm = vSpeech * 0.4

    p.leftEyebrowY = browLift
    p.rightEyebrowY = browLift
    p.leftEyebrowAngle = browAngle
    p.rightEyebrowAngle = browAngle
    p.leftEyebrowForm = browForm
    p.rightEyebrowForm = browForm

    // 5) Body: small nod / sway with speech rhythm
    if (vSpeech > 0.05) {
      speechPhase += 0.25
      const amp = vSpeech * 8 // max ±8 degrees
      p.bodyAngleX = amp * Math.sin(speechPhase)
      p.bodyAngleY = amp * 0.5 * Math.cos(speechPhase * 0.8)
    } else {
      // Relax back to neutral when not speaking
      p.bodyAngleX *= 0.8
      p.bodyAngleY *= 0.8
    }

    // 6) Breath: slightly modulated by speech
    const targetBreath = vSpeech > 0.1 ? 0.2 : 0.6
    p.breath = p.breath * 0.9 + targetBreath * 0.1
  }
  catch (e) {
    console.warn('[AIRI] applyAudioToLive2D error', e)
  }
}

// ---------- Independent random blink loop (not tied to audio) ----------
function startBlinkLoop() {
  if (blinkRAF != null)
    cancelAnimationFrame(blinkRAF)

  let lastTime = performance.now()

  const BLINK_DURATION = 120 // ms for closing or opening

  const step = (time: number) => {
    const dt = time - lastTime
    lastTime = time

    if (!live2d?.modelParameters) {
      blinkRAF = requestAnimationFrame(step)
      return
    }

    const p = live2d.modelParameters as any

    // Accumulate time between blinks
    blinkTimer += dt

    // Trigger a new blink
    if (!blinking && blinkTimer >= blinkInterval) {
      blinking = true
      blinkClosing = true
      blinkProgress = 0
      blinkTimer = 0
      // Next interval will be reset when the blink finishes
    }

    if (blinking) {
      blinkProgress += dt / BLINK_DURATION

      if (blinkClosing) {
        const t = Math.min(1, blinkProgress)
        blinkFactor = 1 - t // from 1 -> 0
        if (blinkProgress >= 1) {
          blinkClosing = false
          blinkProgress = 0
        }
      } else {
        const t = Math.min(1, blinkProgress)
        blinkFactor = t // from 0 -> 1
        if (blinkProgress >= 1) {
          blinking = false
          blinkProgress = 0
          blinkFactor = 1
          blinkInterval = randomBetween(2000, 6000)
        }
      }
    } else {
      // No blink in progress, keep eyes fully open from blink's perspective
      blinkFactor = 1
    }

    // Apply eyes using current audio base + blink factor
    const eyeOpenValue = baseEyeOpen * blinkFactor
    p.leftEyeOpen = eyeOpenValue
    p.rightEyeOpen = eyeOpenValue
    p.leftEyeSmile = baseEyeSmile
    p.rightEyeSmile = baseEyeSmile

    blinkRAF = requestAnimationFrame(step)
  }

  console.log('[AIRI] startBlinkLoop')
  blinkRAF = requestAnimationFrame(step)
}

// ---------- Utilities ----------
function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min)
}
</script>

<template>
  <Cross>
    <AnimatedWave
      class="widgets top-widgets"
      :fill-color="dark
        ? 'oklch(35% calc(var(--chromatic-chroma) * 0.6) var(--chromatic-hue))'
        : 'color-mix(in srgb, oklch(95% calc(var(--chromatic-chroma-50) * 0.5) var(--chromatic-hue)) 80%, oklch(100% 0 360))'"
    >
      <div relative flex="~ col" z-2 h-100dvh w-100vw of-hidden>
        <div relative flex="~ 1 row gap-y-0 gap-x-2 <md:col">
          <WidgetStage
            class="airi-stage"
            flex-1 min-w="1/2"
            :paused="false"
            :focus-at="{ x: 0, y: 0 }"
            :x-offset="`${position.x}%`"
            :y-offset="positionInPercentageString.y"
            :scale="scale"
          />
        </div>
      </div>
    </AnimatedWave>
  </Cross>
</template>
