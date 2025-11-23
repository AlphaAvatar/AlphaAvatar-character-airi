<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue"
import {
  Room,
  RoomEvent,
  DataPacket_Kind,
  RemoteTrackPublication,
  RemoteParticipant,
  Track,
} from "livekit-client"

import { useLive2d } from '@proj-airi/stage-ui/stores/live2d'

console.log("🔥 LivekitAvatar.vue loaded at", new Date().toISOString())

const url = import.meta.env.VITE_AIRI_LIVEKIT_URL as string
const token = import.meta.env.VITE_AIRI_LIVEKIT_TOKEN as string
const agentIdentity = import.meta.env.VITE_AIRI_AGENT_IDENTITY as string | undefined

const room = new Room()
const connected = ref(false)

let audioCtx: AudioContext | null = null
let lipsyncRAF: number | null = null

const live2d = useLive2d()

// ----------------------------------------
// Execute when the page is mounted
// ----------------------------------------
onMounted(async () => {
  console.log("URL =", url)
  console.log("TOKEN length =", token?.length ?? 0)

  if (!url || !token) {
    console.error("Missing VITE_AIRI_LIVEKIT_URL or VITE_AIRI_LIVEKIT_TOKEN")
    return
  }

  try {
    console.log("Connecting to LiveKit:", url)
    await room.connect(url, token)
    console.log("Connected to LiveKit!")
    connected.value = true

    await publishCanvasAsVideo()

    room
      .on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
      .on(RoomEvent.DataReceived, handleDataReceived)
    console.log("Register RoomEvent to LiveKit!")
  } catch (e) {
    console.error("Failed to connect to LiveKit:", e)
  }
})

// ----------------------------------------
// Clean up when the page is unloaded
// ----------------------------------------
onBeforeUnmount(() => {
  if (lipsyncRAF != null) cancelAnimationFrame(lipsyncRAF)
  if (audioCtx) audioCtx.close()
  room.disconnect()
})


// ----------------------------------------
// Publish the canvas as a video track
// ----------------------------------------
async function publishCanvasAsVideo() {
  const canvas = document.querySelector("#airi-canvas") as HTMLCanvasElement | null
  if (!canvas) {
    console.warn("[AIRI] No #airi-canvas found, skip video track publish")
    return
  }

  const stream = canvas.captureStream(30) // 30fps
  const [videoTrack] = stream.getVideoTracks()

  await room.localParticipant.publishTrack(videoTrack, {
    name: "airi-avatar",
  })

  console.log("[AIRI] Published canvas as video track")
}

// ----------------------------------------
// Subscribe to a regular audio track → Use AnalyserNode for lip-syncing
// Currently using DataStreamAudioOutput, this won't be triggered; you can keep it or delete it for now.
// ----------------------------------------
function handleTrackSubscribed(
  track: Track,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
) {
  if (track.kind !== "audio") return
  if (agentIdentity && participant.identity !== agentIdentity) return

  console.log("[AIRI] Received audio track from agent:", participant.identity)

  const mediaStream = new MediaStream([track.mediaStreamTrack])
  const audioEl = new Audio()
  audioEl.srcObject = mediaStream
  audioEl.play().catch((e) => console.warn("[AIRI] auto-play failed:", e))

  audioCtx = new AudioContext()
  const source = audioCtx.createMediaStreamSource(mediaStream)
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 2048

  source.connect(analyser)

  startLipsyncFromAnalyser(analyser)
}

// ----------------------------------------
// DataTrack → viseme (to be actually enabled later)
// ----------------------------------------
function handleDataReceived(
  payload: Uint8Array<ArrayBufferLike>,
  participant?: RemoteParticipant,
  kind?: DataPacket_Kind,
  topic?: string,
  encryptionType?: any,
): void {
  if (topic !== "viseme") return

  if (!payload) return

  try {
    const msg = JSON.parse(new TextDecoder().decode(payload))
    applyViseme(msg)
  } catch (e) {
    console.warn("[AIRI] invalid viseme payload", e)
  }
}

// ----------------------------------------
// Simple volume mouth shape (can be replaced with viseme)
// ----------------------------------------
function startLipsyncFromAnalyser(analyser: AnalyserNode) {
  const data = new Uint8Array(analyser.fftSize)

  const loop = () => {
    analyser.getByteTimeDomainData(data)

    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = data[i] - 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)

    const mouthOpen = Math.min(1, rms / 40)
    setLive2DMouthOpen(mouthOpen)

    lipsyncRAF = requestAnimationFrame(loop)
  }

  loop()
}

// ----------------------------------------
// viseme → Live2D parameters
// (Use this interface when submitting viseme from Python in the future)
// ----------------------------------------
function applyViseme(msg: { index: number; weight?: number; at?: number }) {
  const weight = msg.weight ?? 1.0
  const open = Math.min(1, weight)
  setLive2DMouthOpen(open)
}

// ----------------------------------------
// The place where Live2D is actually controlled
// ----------------------------------------
function setLive2DMouthOpen(value: number) {
  const v = Math.min(1, Math.max(0, value))

  live2d.modelParameters.mouthOpen = v
  live2d.shouldUpdateView()
}
</script>

<template>
  <div class="w-full h-full">
    <!-- Here is your AIRI Live2D canvas -->
    <canvas id="airi-canvas" class="w-full h-full"></canvas>
  </div>
</template>
