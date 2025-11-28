// Simple PCM16 playback Worklet:
// Receives a Uint8Array (or ArrayBuffer) from the port, converts it to Float32, and pushes it to the output buffer.
// By default, it only handles mono; it can be expanded later if multi-channel is required.

class PCM16PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // 环形缓冲可以做得复杂一点，这里先用简单数组拼接
    /** @type {Float32Array} */
    this.buffer = new Float32Array(0)

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data)
        return

      let u8
      if (data instanceof Uint8Array) {
        u8 = data
      } else if (data instanceof ArrayBuffer) {
        u8 = new Uint8Array(data)
      } else if (ArrayBuffer.isView(data)) {
        u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      } else {
        return
      }

      const len = u8.byteLength / 2
      const floatData = new Float32Array(len)
      const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)

      for (let i = 0; i < len; i++) {
        const s = view.getInt16(i * 2, true) // little-endian
        floatData[i] = s / 32768
      }

      // 追加到缓冲里
      const merged = new Float32Array(this.buffer.length + floatData.length)
      merged.set(this.buffer, 0)
      merged.set(floatData, this.buffer.length)
      this.buffer = merged
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]
    if (!output || output.length === 0)
      return true

    const channel = output[0] // 只做单声道

    const frames = channel.length
    if (this.buffer.length >= frames) {
      channel.set(this.buffer.subarray(0, frames))
      this.buffer = this.buffer.subarray(frames)
    } else {
      // 不够就播完剩下的，后面补 0
      channel.set(this.buffer)
      if (this.buffer.length < frames)
        channel.fill(0, this.buffer.length)
      this.buffer = new Float32Array(0)
    }

    return true
  }
}

registerProcessor('pcm16-player', PCM16PlayerProcessor)
