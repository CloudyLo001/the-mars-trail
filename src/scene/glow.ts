/**
 * A soft radial glow, drawn once into a canvas and shared.
 *
 * Used anywhere something needs to look lit — drive plumes, launch exhaust —
 * without paying for a real light or a bloom pass. Sprites keep it facing the
 * camera, so one texture covers every angle.
 */

import * as THREE from 'three';

export function createGlowTexture(inner = 'rgba(255,255,255,0.9)', outer = '190,235,255'): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create glow texture context.');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, `rgba(${outer},0.42)`);
  g.addColorStop(1, `rgba(${outer},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
