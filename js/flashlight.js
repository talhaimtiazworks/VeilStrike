/**
 * flashlight.js — Master upgrade Phase 4: weapon-mounted tactical flashlight.
 *
 * Real scene lighting, never a screen overlay:
 *  - one THREE.SpotLight + target, parented to the camera with a small
 *    right/low offset (weapon-rail position) so it follows look, movement,
 *    ADS and weapon switches with zero per-frame matrix work of our own;
 *  - physically-based falloff (decay ≈ 1.6, finite distance) and a soft
 *    penumbra produce a hot centre that fades into the night scene;
 *  - the light is created ONCE per session and kept in the scene at
 *    intensity 0 when off. three.js bakes the light COUNT into every lit
 *    shader program, so add/remove would recompile all materials (a freeze);
 *    toggling intensity is free;
 *  - quality ladder: HIGH = 512² soft shadow map; MEDIUM/LOW/perf = no
 *    shadow (fallback) and a shorter throw. Shadow flag is only changed by
 *    applyQuality() (settings change), never by the toggle itself.
 *
 * Gameplay trade-off: a lit light raises how quickly hostiles notice the
 * player (player.flashlightOn is read by the existing detection gain).
 */
import * as THREE from 'three';

export const FLASHLIGHT_DEF = {
  color: 0xf4f1e6,          // neutral-warm tactical LED
  intensity: 680,           // candela (physically-correct lights, r160) — clearly illuminates dark interiors & night
  distance: 48,             // metres — usable throw at night
  distanceLow: 32,          // fallback throw (no shadows)
  angle: 0.38,              // half-angle rad (~21.8°)
  penumbra: 0.52,           // soft feathered falloff around intense central hotspot
  decay: 1.6,
  offset: new THREE.Vector3(0.18, -0.16, 0.15), // rail mount relative to camera
};

export class Flashlight {
  constructor(game) {
    this.game = game;
    this.on = false;
    this.light = null;
    this._quality = null;
  }

  /** Create once and parent to the camera (camera must already be in the scene graph). */
  ensure() {
    if (this.light) return this.light;
    const g = this.game, D = FLASHLIGHT_DEF;
    const l = new THREE.SpotLight(D.color, 0, D.distance, D.angle, D.penumbra, D.decay);
    l.name = 'player-flashlight';
    l.position.copy(D.offset);
    l.target.position.set(0, 0, -15);
    l.castShadow = false;
    l.shadow.mapSize.set(512, 512);
    l.shadow.camera.near = 0.2;
    l.shadow.camera.far = D.distance;
    l.shadow.bias = -0.0006;
    l.shadow.normalBias = 0.02;
    g.camera.add(l);
    g.camera.add(l.target);
    if (!g.camera.parent) g.scene.add(g.camera);   // camera children are only rendered when the camera is in the scene
    this.light = l;
    this.applyQuality();
    return l;
  }

  /** Quality ladder (called from applySettings). Shadows only on HIGH and not in perf mode. */
  applyQuality() {
    if (!this.light) return;
    const s = this.game.settings || {};
    const q = s.perfMode ? 'low' : (s.quality || 'medium');
    if (q === this._quality) return;
    this._quality = q;
    const wantShadow = q === 'high';
    if (this.light.castShadow !== wantShadow) {
      this.light.castShadow = wantShadow;
      if (!wantShadow && this.light.shadow.map) { this.light.shadow.map.dispose(); this.light.shadow.map = null; }
    }
    this.light.distance = q === 'low' ? FLASHLIGHT_DEF.distanceLow : FLASHLIGHT_DEF.distance;
  }

  set(on) {
    this.ensure();
    this.on = !!on;
    this.light.intensity = this.on ? FLASHLIGHT_DEF.intensity : 0;
    const p = this.game.player;
    if (p) p.flashlightOn = this.on;
    return this.on;
  }

  toggle() {
    const g = this.game;
    if (g.state !== 'playing' || !g.player || !g.player.alive) return this.on;
    const on = this.set(!this.on);
    if (g.audio && g.audio.wpnClick) g.audio.wpnClick(on ? 2600 : 1800, 0.22);
    if (g.ui && g.ui.refreshTacticalChips) g.ui.refreshTacticalChips();   // LIGHT chip + click = feedback (no extra toast clutter)
    return on;
  }

  /** Mission start / teardown / death: light off, no state leaks across missions. */
  reset() { if (this.light) this.set(false); else this.on = false; }
}
