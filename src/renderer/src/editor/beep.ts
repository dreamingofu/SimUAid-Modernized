// Short WebAudio blip played when a wire makes a valid connection (matching the
// original SimUaid's connection beep). Dependency-free; fails silently if audio
// is unavailable.

let audioContext: AudioContext | null = null

export function beep(): void {
  try {
    audioContext ??= new AudioContext()
    const osc = audioContext.createOscillator()
    const gain = audioContext.createGain()
    osc.frequency.value = 880
    gain.gain.value = 0.04
    osc.connect(gain)
    gain.connect(audioContext.destination)
    osc.start()
    osc.stop(audioContext.currentTime + 0.06)
  } catch {
    // Ignore — audio is a nicety, not required.
  }
}
