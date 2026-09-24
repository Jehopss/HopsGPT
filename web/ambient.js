// Background animation for the empty "new chat" screen: a field of dots that
// drifts in slow waves, with a soft light wandering across it (and following the
// pointer). The middle stays calm behind the greeting (a CSS mask in style.css).
// Colors come from the theme (--faint for dots, --dot for the light), it pauses
// whenever it's hidden, and it holds still for "reduce motion".

export function createAmbient(canvas) {
  const ctx = canvas.getContext('2d')
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  const GAP = 26
  const FRAME_MS = 1000 / 30
  let width = 0
  let height = 0
  let dpr = 1
  let running = false
  let raf = 0
  let last = 0
  let t = Math.random() * 1000
  let colors = null
  const pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4 }

  function readColors() {
    const css = getComputedStyle(canvas)
    colors = { dot: css.getPropertyValue('--faint').trim() || '#8f8f88', glow: css.getPropertyValue('--dot').trim() || '#2f6bff' }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect()
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    width = rect.width
    height = rect.height
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!running || reduce.matches) draw()
  }

  function draw() {
    if (!colors) readColors()
    ctx.clearRect(0, 0, width, height)
    if (!width || !height) return
    pointer.x += (pointer.tx - pointer.x) * 0.12
    pointer.y += (pointer.ty - pointer.y) * 0.12
    // A light that drifts slowly around the screen on its own
    const lx = width * (0.5 + 0.36 * Math.sin(t * 0.23))
    const ly = height * (0.5 + 0.34 * Math.sin(t * 0.31 + 1.3))
    const lightReach = Math.max(180, Math.min(width, height) * 0.38)
    const edge = 90
    const cols = Math.ceil(width / GAP) + 1
    const rows = Math.ceil(height / GAP) + 1
    const ox = (width - (cols - 1) * GAP) / 2
    const oy = (height - (rows - 1) * GAP) / 2
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x0 = ox + i * GAP
        const y0 = oy + j * GAP
        // Two slow waves crossing each other
        const wave = Math.sin(x0 * 0.012 + t * 0.9) * Math.cos(y0 * 0.014 - t * 0.7) +
          Math.sin((x0 + y0) * 0.006 - t * 0.5) * 0.6
        const x = x0 + Math.cos(t * 0.6 + j * 0.3) * 1.5
        const y = y0 + wave * 3.2
        // Softer toward the screen edges
        const fade = Math.min(1, x / edge, y / edge, (width - x) / edge, (height - y) / edge)
        if (fade <= 0) continue
        const light = Math.max(0, 1 - Math.hypot(x - lx, y - ly) / lightReach) ** 2
        const near = Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / 160)
        const glow = Math.min(1, light * 0.8 + near)
        const alpha = Math.min(0.95, (0.2 + (wave + 1.6) * 0.1) * fade + glow * 0.55)
        if (alpha < 0.02) continue
        ctx.globalAlpha = alpha
        ctx.fillStyle = glow > 0.12 ? colors.glow : colors.dot
        ctx.beginPath()
        ctx.arc(x, y, 1.1 + (wave + 1.6) * 0.3 + glow * 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  function frame(now) {
    if (!running) return
    raf = requestAnimationFrame(frame)
    if (now - last < FRAME_MS) return
    const dt = Math.min(0.1, (now - last) / 1000 || 0)
    last = now
    t += dt * 0.55
    draw()
  }

  function start() {
    if (running) return
    running = true
    readColors()
    resize()
    if (reduce.matches) return draw()
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }

  function stop() {
    running = false
    cancelAnimationFrame(raf)
  }

  const observer = new ResizeObserver(() => resize())
  observer.observe(canvas)
  window.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect()
    pointer.tx = event.clientX - rect.left
    pointer.ty = event.clientY - rect.top
  }, { passive: true })
  document.addEventListener('pointerleave', () => {
    pointer.tx = -1e4
    pointer.ty = -1e4
  })
  document.addEventListener('visibilitychange', () => {
    if (!running) return
    if (document.hidden) cancelAnimationFrame(raf)
    else if (!reduce.matches) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
  })
  // Theme changes (Settings or the OS) → pick up the new colors
  const refresh = () => {
    readColors()
    if (!running || reduce.matches) draw()
  }
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh)
  reduce.addEventListener('change', () => {
    if (!running) return
    stop()
    start()
  })

  return { start, stop, get running() { return running } }
}
