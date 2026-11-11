/**
 * music.js — background music player for VEILSTRIKE's one bundled soundtrack.
 *
 * CANONICAL DIRECTORY: /assets/music/
 * The sole track is bundled locally and included in the offline precache.
 */

export const CANONICAL_MUSIC_DIR = '/assets/music';

export const MUSIC_TRACKS = [
  { id: 'ins-fearless-pt-2', name: 'FEARLESS PT 2', file: '/assets/music/FEARLESS-PT-II.mp3' },
];

export const MUSIC_ORDER = MUSIC_TRACKS.map(t => t.id);
export const DEFAULT_TRACK = 'ins-fearless-pt-2';

/** Commercial masters are loud; a fixed trim keeps 100% music below gunfire. */
const MUSIC_TRIM = 0.55;

export const byId = (id) => MUSIC_TRACKS.find(t => t.id === id) || null;

/** Return the one exact canonical path configured for this track. */
function getCandidateUrls(track) {
  if (!track || !track.file || !track.file.startsWith(`${CANONICAL_MUSIC_DIR}/`)) return [];
  return [track.file];
}

export class MusicSystem {
  constructor(game) {
    this.game = game;
    this.trackId = DEFAULT_TRACK;
    this.state = 'stopped';        // stopped | loading | playing | paused | blocked | error | off
    this.failed = new Set();       // track ids that failed to load this session
    this.el = null;                // the single <audio> element
    this._srcNode = null;          // MediaElementSource (created once)
    this._trim = null;
    this._auto = false;            // current playback is continuous (auto-advance on end/error)
    this._history = [];            // shuffle "previous" stack
    this._candidateIndex = 0;      // current candidate url being tried
    this._candidateList = [];      // candidate urls for current track
    this._generation = 0;          // ignores stale play() rejections after track switches
    this.onChange = null;          // UI hook
    this.stats = { plays: 0, errors: 0, elementsCreated: 0, listenersAttached: 0 };
    this.lastError = null;
  }

  get settings() { return this.game.settings || {}; }
  get enabled() { return this.settings.musicEnabled !== false; }
  get shuffle() { return !!this.settings.musicShuffle; }
  get track() { return byId(this.trackId); }
  get allTracks() { return MUSIC_TRACKS; }
  get playing() { return this.state === 'playing' || this.state === 'loading'; }

  // ---- element + routing (created once) ---------------------------------
  _ensureEl() {
    if (this.el) return this.el;
    const el = new Audio();
    el.preload = 'none';
    el.loop = false;
    el.setAttribute('playsinline', '');
    el.addEventListener('playing', () => {
      this.failed.delete(this.trackId);
      this._set('playing');
    });
    el.addEventListener('waiting', () => {
      if (!el.paused) this._set('loading');
    });
    el.addEventListener('pause', () => {
      if (el.paused && (this.state === 'playing' || this.state === 'loading')) {
        this._set('paused');
      }
    });
    el.addEventListener('ended', () => {
      this.next(true);
    });
    el.addEventListener('error', () => {
      this._onError();
    });
    this.stats.listenersAttached += 6;
    this.stats.elementsCreated++;
    this.el = el;
    return el;
  }

  /** Route the element through the music bus (needs the unlocked AudioContext). */
  _route() {
    const a = this.game.audio;
    if (this._srcNode || !a || !a.ready || !a.ctx || !a.musicBus) {
      this._applyFallbackVolume();
      return !!this._srcNode;
    }
    try {
      this._srcNode = a.ctx.createMediaElementSource(this.el);
      this._trim = a.ctx.createGain();
      this._trim.gain.value = MUSIC_TRIM;
      this._srcNode.connect(this._trim);
      this._trim.connect(a.musicBus);
      this.el.volume = 1;            // level is owned by musicBus from now on
    } catch (_) {
      this._srcNode = null;          // fall back to element volume
      this._applyFallbackVolume();
    }
    return !!this._srcNode;
  }

  /** Only used when Web Audio routing is unavailable. */
  _applyFallbackVolume() {
    if (!this.el || this._srcNode) return;
    const s = this.settings;
    const v = (s.musicVolume != null ? s.musicVolume : 0.45) *
              (s.masterVolume != null ? s.masterVolume : 0.8) *
              MUSIC_TRIM;
    this.el.volume = Math.max(0, Math.min(1, v));
  }

  setVolume(v) {
    const a = this.game.audio;
    if (a && a.setMusicVolume) a.setMusicVolume(v);
    this._applyFallbackVolume();
  }

  // ---- transport ---------------------------------------------------------
  /** Select a track. Stops the previous one cleanly; plays if asked (or if already playing). */
  select(id, opts = {}) {
    const t = byId(id) || byId(DEFAULT_TRACK);
    const wasPlaying = this.playing;
    if (this.trackId !== t.id) this._history.push(this.trackId);
    if (this._history.length > 20) this._history.shift();
    this.trackId = t.id;
    this.settings.musicTrack = t.id;

    // Reset candidates for newly selected track
    this._candidateList = getCandidateUrls(t);
    this._candidateIndex = 0;
    this.failed.delete(t.id); // clear failed state on explicit user selection
    this.lastError = null;

    if (this.el) {
      this._generation++;
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();                 // aborts old stream
    }

    const play = opts.play != null ? opts.play : wasPlaying;
    if (play) return this.play({ auto: !!opts.auto });
    this._set(this.enabled ? 'stopped' : 'off');
    return true;
  }

  play(opts = {}) {
    if (!this.enabled) { this._set('off'); return false; }
    const a = this.game.audio;
    if (a && !a.ready && a.init) a.init();
    if (a && a.ready && a.ctx && a.ctx.state === 'suspended') {
      a.ctx.resume().catch(() => {});
    }

    const t = this.track || byId(DEFAULT_TRACK);
    if (!this._candidateList || this._candidateList.length === 0) {
      this._candidateList = getCandidateUrls(t);
      this._candidateIndex = 0;
    }

    const el = this._ensureEl();
    this._route();

    const currentUrl = this._candidateList[this._candidateIndex] || t.file;
    const want = new URL(currentUrl, document.baseURI).href;
    if (el.src !== want) {
      el.src = want;                 // URL() safely encodes spaces and resolves deployment subpaths
      try { el.currentTime = 0; } catch (_) {}
    }

    this._auto = opts.auto != null ? !!opts.auto : true;
    this.settings.musicPaused = false;
    this._set('loading');

    const generation = ++this._generation;
    let p;
    try {
      p = el.play();
    } catch (e) {
      this._playRejected(e, generation);
      return false;
    }
    if (p && p.then) {
      p.then(() => {
        if (generation !== this._generation) return;
        this.stats.plays++;
        this.failed.delete(t.id);
        this._set('playing');
      }).catch(e => this._playRejected(e, generation));
    }
    return true;
  }

  _playRejected(e, generation = this._generation) {
    if (generation !== this._generation) return; // stale rejection from a switched track
    if (e && e.name === 'NotAllowedError') {
      this._set('blocked');
      return;
    }
    if (e && e.name === 'AbortError') return;          // superseded by a newer select()/pause()
    if (this.el && this.el.error) return;              // 'error' event will handle it
    this._onError();
  }

  pause(user = true) {
    // Invalidate an unresolved play() promise so it cannot restore PLAYING
    // after the user has paused or after the active track was stopped.
    this._generation++;
    if (!this.el) { this._set(this.enabled ? 'stopped' : 'off'); return; }
    this.el.pause();
    if (user) this.settings.musicPaused = true;
    this._set(this.enabled ? 'paused' : 'off');
  }

  /** Play / Pause / Resume — one button. */
  toggle() {
    if (this.playing) {
      this.pause(true);
      return 'paused';
    }
    this.play({ auto: true });
    return this.state;
  }

  next(auto = false) {
    const id = this._pick(+1);
    if (!id) {
      // If all failed, reset failed cache on explicit manual click so user can retry
      if (!auto) {
        this.failed.clear();
        const curIdx = MUSIC_ORDER.indexOf(this.trackId);
        const nextId = MUSIC_ORDER[(curIdx + 1) % MUSIC_ORDER.length];
        this.select(nextId, { play: true, auto: false });
        return nextId;
      }
      this._allFailed();
      return null;
    }
    this.select(id, { play: auto ? true : this.playing, auto: true });
    return id;
  }

  prev() {
    let id = null;
    if (this.shuffle) {
      while (this._history.length && !id) {
        const h = this._history.pop();
        if (h !== this.trackId && !this.failed.has(h)) id = h;
      }
    }
    if (!id) id = this._pick(-1);
    if (!id) {
      this.failed.clear();
      const curIdx = MUSIC_ORDER.indexOf(this.trackId);
      const prevId = MUSIC_ORDER[(curIdx - 1 + MUSIC_ORDER.length) % MUSIC_ORDER.length];
      this.select(prevId, { play: true, auto: false });
      return prevId;
    }
    const play = this.playing;
    this.select(id, { play, auto: true });
    if (this.shuffle) this._history.pop();
    return id;
  }

  _pick(dir) {
    const ok = MUSIC_ORDER.filter(id => !this.failed.has(id));
    if (!ok.length) return null;
    if (this.shuffle && ok.length > 1) {
      const pool = ok.filter(id => id !== this.trackId);
      return pool[Math.floor(Math.random() * pool.length)];
    }
    let i = MUSIC_ORDER.indexOf(this.trackId);
    for (let k = 0; k < MUSIC_ORDER.length; k++) {
      i = (i + dir + MUSIC_ORDER.length) % MUSIC_ORDER.length;
      if (!this.failed.has(MUSIC_ORDER[i])) return MUSIC_ORDER[i];
    }
    return null;
  }

  setShuffle(on) {
    this.settings.musicShuffle = !!on;
    this._history.length = 0;
    this._emit();
  }

  setEnabled(on) {
    this.settings.musicEnabled = !!on;
    if (!on) {
      this._auto = false;
      this._generation++;
      if (this.el) this.el.pause();
      this._set('off');
    } else if (!this.settings.musicPaused) {
      this.play({ auto: true });
    } else {
      this._set('paused');
    }
  }

  /** First user gesture (AudioContext unlocked). */
  onUnlock() {
    if (!this.enabled) { this._set('off'); return; }
    if (this.settings.musicPaused) { this._set('paused'); return; }
    if (!this.playing) {
      this._autoStartAt = performance.now();
      this.play({ auto: true });
    }
  }

  // ---- mission lifecycle hooks --------------------------------------------
  begin() {
    if (this.enabled && !this.settings.musicPaused && !this.playing) {
      this.play({ auto: true });
    }
  }

  end() { /* music keeps playing */ }
  cycle() { return this.next(false) || this.trackId; }
  setTrack(id) { return this.select(id, {}); }

  // ---- failures ----------------------------------------------------------
  _onError() {
    if (this.el && !this.el.getAttribute('src')) return; // src cleared by switch

    const t = this.track;
    const mediaCode = this.el && this.el.error ? this.el.error.code : 0;
    const mediaReason = ({ 1: 'PLAYBACK ABORTED', 2: 'NETWORK OR FILE PATH ERROR',
      3: 'AUDIO DECODE ERROR', 4: 'FILE MISSING OR FORMAT UNSUPPORTED' })[mediaCode] || 'MEDIA LOAD ERROR';
    this.lastError = { trackId: t ? t.id : this.trackId, file: t ? t.file : '',
      mediaCode, reason: mediaReason, at: Date.now() };

    // Check if there are other candidate paths to try for this track
    if (this._candidateList && this._candidateIndex + 1 < this._candidateList.length) {
      this._candidateIndex++;
      const nextCandidate = this._candidateList[this._candidateIndex];
      if (this.el) {
        this.el.src = new URL(nextCandidate, document.baseURI).href;
        try { this.el.currentTime = 0; } catch (_) {}
        const generation = ++this._generation;
        let p;
        try { p = this.el.play(); } catch (e) { this._playRejected(e, generation); return; }
        if (p && p.catch) p.catch(e => this._playRejected(e, generation));
        return;
      }
    }

    // All candidates failed for this track
    this.stats.errors++;
    if (t) this.failed.add(t.id);
    const name = t ? t.name : 'TRACK';
    const ui = this.game.ui;
    if (ui && ui.toastBrief) ui.toastBrief(`MUSIC: ${name} UNAVAILABLE`);
    this._set('error');

    if (this._auto && this.failed.size < MUSIC_ORDER.length) {
      const id = this._pick(+1);
      if (id) {
        setTimeout(() => {
          if (this.state === 'error') this.select(id, { play: true, auto: true });
        }, 250);
      }
    } else if (this.failed.size >= MUSIC_ORDER.length) {
      this._allFailed();
    }
  }

  _allFailed() {
    if (this.el) this.el.pause();
    this._set('error');
    const ui = this.game.ui;
    if (ui && ui.toastBrief) ui.toastBrief('SOUNDTRACK TRACKS UNAVAILABLE');
  }

  // ---- status ------------------------------------------------------------
  _set(st) {
    if (this.state !== st) {
      this.state = st;
    }
    this._emit();
  }

  _emit() {
    if (this.onChange) {
      try { this.onChange(this); } catch (_) {}
    }
  }

  statusText() {
    const t = this.track, n = t ? t.name : '';
    switch (this.state) {
      case 'playing': return 'NOW PLAYING · ' + n;
      case 'loading': return 'LOADING · ' + n;
      case 'paused':  return 'PAUSED · ' + n;
      case 'blocked': return 'PRESS PLAY TO START';
      case 'error': {
        if (this.failed.size >= MUSIC_ORDER.length) return 'SOUNDTRACK UNAVAILABLE';
        const diagnostic = this.diagnostics.find(d => d.id === this.trackId);
        if (diagnostic && diagnostic.status === 'missing') return 'FILE MISSING · ' + n;
        const detail = this.lastError && this.lastError.trackId === this.trackId ? this.lastError.reason : 'FILE MISSING OR UNREADABLE';
        return 'MUSIC ERROR · ' + n + ' · ' + detail;
      }
      case 'off':     return 'MUSIC OFF';
      default:        return 'STOPPED · ' + n;
    }
  }

  /** Label of the single PLAY / PAUSE / RESUME button. */
  playLabel() {
    if (this.playing) return '❚❚ PAUSE';
    if (this.state === 'paused') return '▶ RESUME';
    return '▶ PLAY';
  }
}
