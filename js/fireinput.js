/**
 * fireinput.js — the single authoritative pipeline between a physical fire
 * input (mouse button, fire key, touch fire button, aim-assist) and the
 * weapon trigger.
 *
 * Why this exists (the "one click = three shots" defect):
 * `Game._bindInput` only recorded whether LMB was *down* (`input.mouse0`), and
 * the frame loop fed that held boolean straight into `WeaponSystem.tryFire`.
 * A semi-automatic weapon survives that because it demands a fresh press edge,
 * but an automatic weapon treats "held" as "keep firing": a human click is not
 * one frame, it is ~60–300 ms, so one click became 1–3 firing events (VX-4 at
 * 660 RPM = 3 shots from a 250 ms click). Nothing was duplicating the shot —
 * the click was being read as a short hold, which is exactly what the brief
 * forbids ("a click must not be interpreted as a continuous hold").
 *
 * The rules this module enforces, for every input source:
 *   • a discrete press  → exactly ONE trigger event, in any fire mode
 *   • events are queued, not dropped, so rapid clicks all fire (bounded bank)
 *   • a *sustained* hold continues auto fire, but only past AUTO_ENGAGE_S
 *   • release stops fire immediately; a press from a second source while one is
 *     already held adds no extra event (no mouse+key double-fire)
 *   • repeated binding/registration cannot multiply the pipeline
 *
 * Ammunition accounting is deliberately NOT here: one accepted trigger event
 * becomes exactly one round inside `WeaponSystem.tryFire` (via `spendRound`).
 */

export const FIRE_INPUT = {
  AUTO_ENGAGE_S: 0.25,     // a press shorter than this is a click, not a hold
  CLICK_STALE_S: 0.28,     // a queued click the weapon refused this long is dropped
  MAX_QUEUED: 2,           // never bank a burst of shots from button-mashing
};

export class FireTriggerInput {
  constructor(opts = {}) {
    // A missing or non-numeric value must NOT mean "engage instantly": that is how a
    // saved settings object from before this option existed would silently restore
    // the three-shots-per-click behaviour. Only an explicit number overrides it.
    this.autoEngageS = Number.isFinite(opts.autoEngageS)
      ? Math.max(0, opts.autoEngageS)
      : FIRE_INPUT.AUTO_ENGAGE_S;
    this.staleS = opts.staleS ?? FIRE_INPUT.CLICK_STALE_S;
    this.maxQueued = opts.maxQueued ?? FIRE_INPUT.MAX_QUEUED;
    this._held = new Set();          // which sources are physically down
    this._pending = 0;               // discrete clicks awaiting a cadence window
    this._pendingSince = -1;
    this._holdT = 0;                 // seconds since the current press began
    this._assisted = false;          // aim-assist auto-fire (treated as a hold)
    this.presses = 0;                // counters for tests/telemetry
    this.events = 0;
    this.blockedEvents = 0;
    this.droppedStale = 0;
    this.droppedBusy = 0;
  }

  /** Physical press. Repeats from the same source, or a second source while a
   * press is already held, never create an extra firing event. */
  press(source, now = 0) {
    if (this._held.has(source)) return false;
    const wasHeld = this._held.size > 0;
    this._held.add(source);
    this.presses++;
    // Only the first source to go down starts a firing event. If a second source
    // (fire key, touch button, aim-assist) is already/also down, that is the same
    // trigger action, not another one — this is what keeps mouse + keyboard from
    // double-firing one intended shot.
    if (wasHeld) return false;
    this._holdT = 0;                                     // the press began now
    this._pending = Math.min(this.maxQueued, this._pending + 1);
    if (this._pending === 1) this._pendingSince = now;
    return true;
  }

  release(source) {
    if (!this._held.delete(source)) return false;
    if (!this._held.size) this._holdT = 0;
    return true;
  }

  /** Aim-assist auto-fire: a hold, not a click (it must not bank a shot). */
  setAssistHeld(on) { this._assisted = !!on; }

  get held() { return this._held.size > 0 || this._assisted; }
  get pending() { return this._pending; }
  reset() {
    this._held.clear();
    this._pending = 0; this._holdT = 0; this._assisted = false; this._pendingSince = -1;
  }

  /**
   * The trigger signal for this frame.
   * `accepting` — the weapon can take a shot right now (ready + cadence elapsed
   * + not blocked until release). `busy` — the weapon is in a state that must
   * swallow a click outright (reload, drawing, malfunction recovery).
   */
  sample(now, dt, { mode = 'semi', accepting = true, busy = false } = {}) {
    if (this.held) this._holdT += dt;
    if (this._pending > 0) {
      if (busy) {
        // Don't let a click pressed during a reload be paid out afterwards.
        this._pending = 0; this.droppedBusy++;
      } else if (!accepting) {
        if (now - this._pendingSince > this.staleS) { this._pending = 0; this.droppedStale++; }
        else { this.blockedEvents++; return false; }        // keep waiting, don't fire early
      } else {
        this._pending--;
        if (!this._pending) this._pendingSince = -1;
        else this._pendingSince = now;                      // re-arm for the next queued click
        this.events++;
        return true;                                        // exactly one firing event
      }
    }
    // Sustained hold: only automatic weapons keep firing, and only once the
    // press has clearly been a hold rather than a click.
    if ((mode === 'auto' || this._assisted) && this.held && this._holdT >= this.autoEngageS) return true;
    return false;
  }
}
