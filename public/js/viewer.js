// The .glb preview on the pack page.
//
// A thumbnail tells you what an asset looks like from one angle; a store has to let you
// turn it over. three.js is served from the store's own node_modules (see the import map
// on pack.html), so nothing here reaches out to a CDN.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

// Read the page's own palette so the viewport belongs to the design rather than being a
// grey box parked in the middle of it.
function paperColor() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--paper-2').trim()
  return new THREE.Color(value || '#f6f7f9')
}

export function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = paperColor()

  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200)
  camera.position.set(1.6, 1.2, 2.1)

  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(2.5, 3.5, 2)
  const fill = new THREE.DirectionalLight(0xccd8ff, 0.7)
  fill.position.set(-2.5, 1, -1.5)
  scene.add(key, fill, new THREE.HemisphereLight(0xffffff, 0x3a3f47, 1.0))

  // A ground plane the model can sit on — assets are authored with the pivot at the base,
  // so without it they look like they are floating.
  const grid = new THREE.GridHelper(6, 24, 0xd4d8dd, 0xeaedf1)
  grid.material.transparent = true
  grid.material.opacity = 0.5
  scene.add(grid)

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false
  controls.minDistance = 0.3
  controls.maxDistance = 20

  const loader = new GLTFLoader()
  let current = null
  let disposed = false

  function resize() {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    renderer.setSize(rect.width, rect.height, false)
    camera.aspect = rect.width / rect.height
    camera.updateProjectionMatrix()
  }

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()

  function frame(object) {
    const box = new THREE.Box3().setFromObject(object)
    const size = box.getSize(new THREE.Vector3())
    const centre = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.length() / 2, 0.05)
    // Assets are authored facing -Z, but the camera sits on the +Z side, so spin the
    // model 180° about Y to face the viewer. The tilt (camera elevation) is untouched.
    object.rotation.y = Math.PI
    // Sit the model on the grid rather than on its own origin.
    object.position.y -= box.min.y
    centre.y -= box.min.y
    controls.target.copy(centre)
    const distance = radius / Math.sin((camera.fov * Math.PI) / 360)
    camera.position.copy(centre).add(new THREE.Vector3(0.75, 0.55, 1).normalize().multiplyScalar(distance * 1.15))
    camera.near = Math.max(distance / 100, 0.001)
    camera.far = distance * 20
    camera.updateProjectionMatrix()
    controls.update()
    grid.scale.setScalar(Math.max(radius / 1.2, 0.35))
  }

  function clear() {
    if (!current) return
    scene.remove(current)
    current.traverse((node) => {
      if (node.isMesh) {
        node.geometry?.dispose?.()
        const materials = Array.isArray(node.material) ? node.material : [node.material]
        for (const m of materials) m?.dispose?.()
      }
    })
    current = null
  }

  async function show(url) {
    const gltf = await loader.loadAsync(url)
    if (disposed) return
    clear()
    current = gltf.scene
    scene.add(current)
    frame(current)
  }

  let raf
  function tick() {
    raf = requestAnimationFrame(tick)
    controls.update()
    renderer.render(scene, camera)
  }
  tick()

  // The palette flips with the OS theme; the viewport follows it.
  const media = matchMedia('(prefers-color-scheme: dark)')
  const onScheme = () => {
    scene.background = paperColor()
  }
  media.addEventListener('change', onScheme)

  return {
    show,
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      media.removeEventListener('change', onScheme)
      clear()
      controls.dispose()
      renderer.dispose()
    }
  }
}
