/**
 * ui.js
 * DOM-based HUD and menu layer. All screens live in index.html; this module
 * wires them up and updates the HUD each frame. Values are cached so the DOM
 * is only touched when something actually changes (no layout thrash in the
 * game loop).
 */
import * as THREE from 'three';

const _tacV = new THREE.Vector3();   // reusable projection scratch (zero-alloc)
import { MISSION_DEFS } from './missions.js';
import { MEDALS, FINISHES, RANKS, DIFFICULTIES, MISSION_ORDER } from './progress.js';
import { ENVIRONMENT_CATEGORIES, CAMPAIGN_ACTS, getMissionMinEnemies } from './campaign-data.js';
import { WEAPON_DEFS } from './weapons.js';
import { THROWABLE_DEFS } from './throwables.js';
import { CARRY_BUDGET } from './loadout.js';

/** Phase 16 — screens that live under the shared cinematic menu shell. */
const SHELL_MENU_SCREENS = ['menu', 'select', 'missions', 'loadout', 'armory',
  'intel', 'awards', 'stats', 'settings', 'credits', 'tutorial', 'brief'];
import { ARMORY_ORDER, WEAPON_UNLOCKS, CHARACTER_UNLOCKS, CAMPAIGN_ONLY, unlockProgress, unlockProgressText } from './unlocks.js';
import { CHARACTER_ORDER, CHARACTER_DEFS } from './characters.js';

const $ = (id) => document.getElementById(id);

/* FINAL MOBILE UX FIX — the ONE label formatter for every volume slider
 * (Master, SFX, Ambience, Music). Settings store normalised 0–1 values; this
 * only formats them for display (never written back), clamped so a label can
 * not read past 0–100 %. */
export function volPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0%';
  return Math.round(Math.min(1, Math.max(0, n)) * 100) + '%';
}

/** Pure HUD accounting shared with tests so magazine, total, and reload cues
 * stay consistent for conventional magazines and continuous-feed weapons. */
export function ammoHudState(def, st) {
  const total = Math.max(0, st.mag + st.reserve);
  return {
    total,
    suggestReload: !def.noReload && st.mag === 0 && st.reserve > 0,
    noReloadMessage: def.noReload
      ? (total === 0 ? 'OUT OF AMMO — RESUPPLY UNAVAILABLE' : 'CONTINUOUS SUPPLY · NO RELOAD')
      : null,
  };
}

export class UI {
  constructor(game) {
    this.game = game;

    this.screens = {
      loading: $('screen-loading'),
      menu: $('screen-menu'),
      select: $('screen-select'),
      settings: $('screen-settings'),
      credits: $('screen-credits'),
      pause: $('screen-pause'),
      death: $('screen-death'),
      complete: $('screen-complete'),
      failed: $('screen-failed'),
      missions: $('screen-missions'),
      armory: $('screen-armory'),
      loadout: $('screen-loadout'),
      intel: $('screen-intel'),
      awards: $('screen-awards'),
      stats: $('screen-stats'),
      tutorial: $('screen-tutorial'),
      brief: $('screen-brief'),
      objectives: $('screen-objectives'),
      error: $('error-overlay'),
      controls: $('screen-controls'),
    };
    this.alertChip = $('alert-chip');
    this.mobnav = $('mobnav');
    this._bindMobNav();
    this._alertLvl = '';
    this.hud = $('hud');
    this.compass = $('compass');
    this.compassCtx = this.compass ? this.compass.getContext('2d') : null;
    this.tacEl = $('tacmap');
    this.tacCanvas = $('tacmap-canvas');
    this.eqWheel = $('eq-wheel');
    this.throwRow = $('throw-row');
    this.throwName = $('throw-name');
    this.throwCount = $('throw-count');
    this.vehHud = $('veh-hud');
    this.vehName = $('veh-name');
    this.vehKmh = $('veh-kmh');
    this.vehGear = $('veh-gear');
    this.vehDmgFill = $('veh-dmg-fill');
    this.vehHint = $('veh-hint');
    this.vehAltitude = $('veh-alt');
    this.vehSeats = $('veh-load');
    this.vehControls = $('veh-controls');
    this.flashbangEl = $('flashbang');
    this.ammoTotal = $('ammo-total');
    this._fb = 0;
    this._wheelHover = null;
    this._wheelCats = null;
    this.tacCtx = this.tacCanvas ? this.tacCanvas.getContext('2d') : null;
    this.armorFill = $('armor-fill');
    this.armorRow = this.armorFill ? this.armorFill.closest('.vital-row') : null;
    this.bandageEl = $('bandage-bar');
    this.bandageFill = $('bandage-fill');
    this._tacOpen = false;
    this._tacStatic = null;
    this._tacB = null;
    this._armorFlashT = 0;

    // hud pieces
    this.objText = $('obj-text');
    this.objSub = $('obj-sub');
    this.objMeta = $('obj-meta');
    this.objAction = $('obj-action');
    this.objHostiles = $('obj-hostiles');
    this.sniperOverlay = $('sniper-scope-overlay');
    this.sniperAllowanceBadge = $('sc-allowance-badge');
    this.lockdownEl = $('lockdown-timer');
    this.ammoMag = $('ammo-mag');
    this.fragEl = $('frag-count');
    this.radioEl = $('radio-line');
    this.pinnedEl = $('suppress-hint');
    this._radioT = 0;
    this.ammoReserve = $('ammo-reserve');
    this.weaponName = $('weapon-name');
    this.weaponState = $('weapon-state');
    this.healthFill = $('health-fill');
    this.healthNum = $('health-num');
    this.staminaFill = $('stamina-fill');
    this.staminaRow = this.staminaFill ? this.staminaFill.closest('.vital-row') : null;
    this.crosshair = $('crosshair');
    this._crossShots = 0;
    this._crossFlashT = 0;
    this.hitmarker = $('hitmarker');
    this.dmgIndicators = $('damage-indicators');
    this.proxAlert = $('proximity-alert');
    this.proxText = $('prox-text');
    this.proxDist = $('prox-dist');
    this.threatRear = $('threat-arc-rear');
    this.threatLeft = $('threat-arc-left');
    this.threatRight = $('threat-arc-right');
    this._proxTimer = 0;
    this.interactPrompt = $('interact-prompt');
    this.interactText = $('interact-text');
    this.hackProgress = $('hack-progress');
    this.hackFill = $('hack-fill');
    this.toastEl = $('objective-toast');
    this.toastLabel = $('toast-label');
    this.toastText = $('toast-text');
    this.damageFlash = $('damage-flash');
    this.vignette = $('vignette');
    this.fps = $('fps-counter');
    this.stance = $('stance-indicator');
    this.loadingBar = $('loading-bar');
    this.loadingStatus = $('loading-status');
    this.loadingPercent = $('loading-percent');
    this.loadingProgress = this.loadingBar ? this.loadingBar.parentElement : null;
    this.loadingTitle = $('loading-title');
    this.loadingLocation = $('loading-location');
    this.loadingWeather = $('loading-weather');
    this.loadingBrief = $('loading-brief');
    this.loadingScreen = $('screen-loading');
    this.weaponClass = $('weapon-class');
    this.weaponMode = $('weapon-mode');

    // caches (avoid touching DOM when unchanged)
    this._c = {};

    // damage indicator pool
    this._dmgPool = [];
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div');
      d.className = 'dmg-indicator';
      d.style.opacity = '0';
      d.style.transition = 'opacity 900ms ease-out';
      this.dmgIndicators.appendChild(d);
      this._dmgPool.push({ el: d, t: 0 });
    }

    this._hitmarkerT = 0;
    this._toastT = 0;
    this._briefT = 0;
    this._fpsT = 0;
    this._fpsFrames = 0;
    this._compassDrawnBearing = null;
    this._compassDrawTimer = 0;

    this.settingsReturnTo = 'menu';
    this._tutorialOrigin = 'menu';
    this._tutorialStep = 0;
  }

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  showScreen(name) {
    const previousScreen = this._shownScreen;
    if (name === 'select') {
      this.syncLoadoutPanel();
      this.syncSelectScreen();
      if (previousScreen !== 'select') {
        const wrapper = this.screens.select && this.screens.select.querySelector('.menu-wrap');
        if (wrapper) wrapper.scrollTop = 0;
      }
    } else if (name === 'menu') {
      this.buildLobby();
    }
    for (const k of Object.keys(this.screens)) {
      this.screens[k].classList.toggle('hidden', k !== name);
    }
    this.hud.classList.toggle('hidden', name !== null);
    if (name !== null) {
      this.closeTacMap();
      if (this.crosshair) {
        this.crosshair.classList.remove('ads', 'sniper-ads');
        this._c.adsMode = 'hip';
      }
      if (this.proxAlert) this.proxAlert.classList.add('hidden');
      if (this.threatRear) this.threatRear.classList.add('hidden');
      if (this.threatLeft) this.threatLeft.classList.add('hidden');
      if (this.threatRight) this.threatRight.classList.add('hidden');
    }
    this._updateMobNav(name);
    // ---- Phase 16: shared menu shell chrome (wallpaper + topbar + drawer) ----
    const inMenus = SHELL_MENU_SCREENS.indexOf(name) >= 0;
    document.body.classList.toggle('in-menus', inMenus);
    document.body.classList.toggle('menu-home', name === 'menu');
    const wall = $('shell-wall'), topbar = $('shell-topbar');
    if (wall) wall.classList.toggle('hidden', !inMenus);
    if (topbar) topbar.classList.toggle('hidden', !inMenus);
    this.closeDrawer();
    if (inMenus) this.buildShell();
    if (name !== 'menu') { const ps = $('perf-suggest'); if (ps) ps.classList.add('hidden'); }
    if (name === null) {
      for (const k of Object.keys(this.screens)) this.screens[k].classList.add('hidden');
    }
    this._shownScreen = name;
    if (name !== null && name !== previousScreen) {
      const screen = this.screens[name];
      const heading = screen && screen.querySelector('h1, h2, .panel-title, .title-main');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        try { heading.focus({ preventScroll: true }); } catch (_) { heading.focus(); }
      }
    }
  }

  hideAll() {
    for (const k of Object.keys(this.screens)) this.screens[k].classList.add('hidden');
  }

  setLoading(p, status, missionId = undefined) {
    this.showScreen('loading');
    if (missionId !== undefined) this.setLoadingBrief(missionId);
    const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
    if (this.loadingBar) this.loadingBar.style.width = `${pct}%`;
    if (this.loadingProgress) this.loadingProgress.setAttribute('aria-valuenow', String(pct));
    if (this.loadingPercent && this._c.loadPct !== pct) {
      this.loadingPercent.textContent = `${String(pct).padStart(2, '0')}%`;
      this._c.loadPct = pct;
    }
    if (status && this.loadingStatus && this._c.loadStatus !== status) {
      this.loadingStatus.textContent = status;
      this._c.loadStatus = status;
    }
  }

  setLoadingBrief(missionId) {
    const def = MISSION_DEFS[missionId] || null;
    const training = missionId === 'range';
    const title = def ? def.title : training ? 'LIVE-FIRE TRAINING' : 'SYSTEM INITIALIZATION';
    const location = def ? (def.loc || def.tag || 'FIELD LOCATION CLASSIFIED')
      : training ? 'TRAINING RANGE · ZERO-ING LANE' : 'STAGING AREA · FIELD NETWORK';
    const metadata = def
      ? [def.cat, def.time, def.wx].filter(Boolean).join('  /  ')
      : training ? 'WEAPONS FAMILIARIZATION  /  AMMUNITION UNLIMITED' : 'OFFLINE READY  /  LOCAL MISSION SYSTEMS';
    const briefing = def && def.brief
      ? def.brief
      : training ? 'Controlled range. Confirm sight alignment, test movement and weapon handling, then deploy when ready.'
      : 'Preparing the field interface and checking local mission systems.';
    if (this.loadingTitle) this.loadingTitle.textContent = title;
    if (this.loadingLocation) this.loadingLocation.textContent = location;
    if (this.loadingWeather) this.loadingWeather.textContent = metadata;
    if (this.loadingBrief) this.loadingBrief.textContent = briefing;
    if (this.loadingScreen) this.loadingScreen.dataset.map = def ? def.map : training ? 'range' : 'staging';
    this._c.loadMission = missionId;
  }

  showError(msg) {
    $('error-message').textContent = msg;
    this.showScreen('error');
  }

  // -------------------------------------------------------------------------
  setObjective(text, sub, meta, nextAction) {
    if (this.objText) this.objText.textContent = text;
    this._objSubBase = sub || '';
    if (this.objSub) this.objSub.textContent = sub || '';
    if (this.objMeta && meta !== undefined) this.objMeta.textContent = meta;
    if (this.objAction && nextAction !== undefined) this.objAction.textContent = nextAction;
    this._objDist = '';
    this._c.obj = text;
  }

  /** Delayed toast — lets a preceding toast (e.g. OBJECTIVE COMPLETE) finish first. */
  toastQueued(label, text, duration = 3.0, delayMs = 2400) {
    setTimeout(() => {
      try { if (this.game.state === 'playing') this.toast(label, text, duration); } catch (e) { /* gone */ }
    }, delayMs);
  }

  toast(label, text, duration = 3.2) {
    this.toastLabel.textContent = label;
    this.toastText.textContent = text;
    this.toastEl.classList.remove('hidden');
    requestAnimationFrame(() => this.toastEl.classList.add('show'));
    this._toastT = duration;
  }

  // =========================================================================
  // C3: flashbang, throw row, equipment wheel, loadout panel
  // =========================================================================
  flashbang(power) {
    this._fb = Math.max(this._fb, Math.min(1, power));
    if (this.flashbangEl) this.flashbangEl.style.opacity = this._fb.toFixed(3);
  }

  setThrowHighlight(mode) {
    if (!this.throwRow) return;
    this.throwRow.classList.toggle('hl-throw', mode === 'throwable');
    this.throwRow.classList.toggle('hl-util', mode === 'utility');
  }

  showEqWheel(game) {
    const cv = this.eqWheel;
    if (!cv) return;
    const ws = game.weapons, th = game.throwables;
    const owned = Array.from(ws.owned || []);
    const mk = (ids) => ids.map(id => ({ id, label: WEAPON_DEFS[id].name }));
    const mkT = (ids) => ids.map(id => ({ id, label: THROWABLE_DEFS[id].name + ' ×' + th.count(id) }));
    const cats = [
      { cat: 'primary', label: 'PRIMARY', items: mk(owned.filter(id => WEAPON_DEFS[id] && WEAPON_DEFS[id].klass !== 'SIDEARM' && !WEAPON_DEFS[id].sidearm)) },
      { cat: 'secondary', label: 'SECONDARY', items: mk(owned.filter(id => WEAPON_DEFS[id] && (WEAPON_DEFS[id].klass === 'SIDEARM' || WEAPON_DEFS[id].sidearm))) },
      { cat: 'throwable', label: 'THROWABLE', items: mkT(th.listWithStock('throwable')) },
      { cat: 'utility', label: 'UTILITY', items: mkT(th.listWithStock('utility')) },
      { cat: 'mission', label: 'MISSION', items: [{ id: 'info', label: 'MISSION GEAR — CARRIED' }] },
    ];
    for (const c of cats) if (!c.items.length) c.items.push({ id: null, label: '— NONE —' });
    this._wheelCats = cats;
    this._wheelHover = null;
    cv.classList.remove('hidden');
    this._drawWheel(0, 0);
  }

  moveWheelCursor(x, y) {
    this._wheelHover = this._wheelHit(x, y);
    this._drawWheel(x, y);
  }

  resolveWheel(x, y) {
    const h = this._wheelHit(x, y);
    if (!h) return null;
    const cat = this._wheelCats[h.catIdx];
    const item = cat.items[h.idx];
    if (!item || !item.id) return h.catIdx === 4 ? { cat: 'mission' } : null;
    return { cat: cat.cat, id: item.id };
  }

  hideEqWheel() {
    if (this.eqWheel) this.eqWheel.classList.add('hidden');
    this._wheelHover = null;
  }

  /** Sector + row hit test in wheel-cursor space (origin = wheel centre). */
  _wheelHit(x, y) {
    const r = Math.hypot(x, y);
    if (r < 26 || r > 168 || !this._wheelCats) return null;
    let ang = Math.atan2(y, x) * 180 / Math.PI;      // -180..180, up = -90
    const rel = ((ang + 90 + 36) % 360 + 360) % 360; // 0 at top-sector left edge
    const catIdx = Math.floor(rel / 72) % 5;
    const cat = this._wheelCats[catIdx];
    const mid = (catIdx * 72 - 90) * Math.PI / 180;
    const py = Math.sin(mid) * 100;
    const n = cat.items.length;
    let j = Math.round((y - py) / 20 + (n - 1) / 2);
    j = Math.max(0, Math.min(n - 1, j));
    return { catIdx, idx: j };
  }

  _drawWheel(curX, curY) {
    const cv = this.eqWheel;
    if (!cv || !this._wheelCats) return;
    const ctx = cv.getContext('2d');
    const cx = 180, cy = 180;
    ctx.clearRect(0, 0, 360, 360);
    const DEG = Math.PI / 180;
    ctx.fillStyle = 'rgba(5, 9, 7, 0.84)';
    ctx.beginPath(); ctx.arc(cx, cy, 170, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120, 200, 140, 0.3)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 170, 0, Math.PI * 2); ctx.stroke();
    const hover = this._wheelHover;
    for (let i = 0; i < 5; i++) {
      const a0 = (i * 72 - 90 - 36) * DEG, a1 = a0 + 72 * DEG;
      const mid = (i * 72 - 90) * DEG;
      if (hover && hover.catIdx === i) {
        ctx.fillStyle = 'rgba(64, 140, 88, 0.24)';
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 168, a0, a1); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(120, 200, 140, 0.22)';
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a0) * 168, cy + Math.sin(a0) * 168); ctx.stroke();
      // category title
      ctx.fillStyle = 'rgba(150, 220, 170, 0.9)';
      ctx.font = '700 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(this._wheelCats[i].label, cx + Math.cos(mid) * 150, cy + Math.sin(mid) * 150 + 3);
      // item rows
      const items = this._wheelCats[i].items;
      const px = Math.cos(mid) * 100, py = Math.sin(mid) * 100;
      ctx.font = '10px monospace';
      for (let j = 0; j < items.length; j++) {
        const ry = cy + py + (j - (items.length - 1) / 2) * 20;
        const rx = cx + px;
        if (hover && hover.catIdx === i && hover.idx === j) {
          ctx.fillStyle = 'rgba(140, 230, 160, 0.9)';
          ctx.fillRect(rx - 74, ry - 9, 148, 17);
          ctx.fillStyle = '#08120c';
        } else {
          ctx.fillStyle = items[j].id ? 'rgba(200, 225, 205, 0.88)' : 'rgba(140, 150, 145, 0.55)';
        }
        ctx.textAlign = 'center';
        ctx.fillText(items[j].label, rx, ry + 3);
      }
    }
    // cursor crosshair
    ctx.strokeStyle = 'rgba(255, 210, 120, 0.95)';
    ctx.lineWidth = 1.5;
    const gx = cx + curX, gy = cy + curY;
    ctx.beginPath();
    ctx.moveTo(gx - 8, gy); ctx.lineTo(gx + 8, gy);
    ctx.moveTo(gx, gy - 8); ctx.lineTo(gx, gy + 8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 210, 120, 0.9)';
    ctx.font = '700 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('RELEASE [Q] TO EQUIP', cx, cy + 6);
  }

  /**
   * Phase-14 ARMORY: ten service weapons with lock states, live requirement
   * progress and one-tap equip. Campaign-issue weapons (VX-12, MPX-5) are not
   * armory items — they remain in the loadout panel as before.
   */
  /**
   * Phase-14 OPERATORS roster: ten selectable characters with distinct,
   * bounded stat packages and one real ability each. Mirroring the arsenal:
   * lock states, live requirement progress, one-tap select.
   */
  buildOperatorPanel() {
    const host = $('operator-list');
    const g = this.game, pr = g && g.progress;
    if (!host || !pr) return;
    host.innerHTML = '';
    const curId = pr.selectedCharacterId;
    const statChip = (label, v, invert = false) => {
      const delta = v - 1;
      if (Math.abs(delta) < 0.005) return `<span class="at-stat">${label} —</span>`;
      const good = invert ? delta < 0 : delta > 0;
      return `<span class="at-stat ${good ? 'up' : 'down'}">${label} ${delta > 0 ? '+' : ''}${Math.round(delta * 100)}%</span>`;
    };
    for (const id of CHARACTER_ORDER) {
      const c = CHARACTER_DEFS[id];
      const req = CHARACTER_UNLOCKS[id];
      if (!c || !req) continue;
      const unlocked = pr.characterUnlocked(id);
      const prog = unlocked ? 1 : unlockProgress('character', id, pr.data);
      const tile = document.createElement('div');
      tile.className = 'armory-tile operator-tile' + (unlocked ? '' : ' locked') + (curId === id ? ' equipped' : '');
      tile.setAttribute('role', 'listitem');

      const head = document.createElement('div');
      head.className = 'at-head';
      head.innerHTML = `<span class="at-name">${c.name}</span><span class="at-role">${c.role}</span>`;
      tile.appendChild(head);

      const stats = document.createElement('div');
      stats.className = 'at-stats';
      stats.innerHTML =
        statChip('HP', c.stats.hp) + statChip('SPD', c.stats.speed) +
        statChip('HDL', c.stats.handling) + statChip('SPR', c.stats.spread, true) +
        (c.stats.visibility !== 1 ? statChip('VIS', c.stats.visibility, true) : '');
      tile.appendChild(stats);

      const desc = document.createElement('div');
      desc.className = 'at-desc';
      desc.textContent = c.desc;
      tile.appendChild(desc);

      if (unlocked) {
        const btn = document.createElement('button');
        btn.className = 'menu-btn at-equip' + (curId === id ? ' equipped-state' : '');
        btn.type = 'button';
        btn.textContent = curId === id ? '✓ ON DEPLOYMENT' : 'SELECT';
        btn.disabled = curId === id;
        btn.addEventListener('click', () => {
          if (!pr.selectCharacter(id)) return;
          g.characters.select(id);          // live-reference for menus/HUD; mission re-applies at start
          this.toastBrief(c.name + ' ON DEPLOYMENT');
          this.buildOperatorPanel();
        });
        tile.appendChild(btn);
      } else {
        const lock = document.createElement('div');
        lock.className = 'at-lock';
        const progTxt = unlockProgressText(CHARACTER_UNLOCKS[id] ? 'character' : 'weapon', id, pr.data);
        const trialNote = id === 'lb9' ? '<span class="at-trial" style="display:block;font-size:9px;color:#6de2c2;margin-top:2px;">(FREE TRIAL IN RANGE · 100 RNDS)</span>' : '';
        lock.innerHTML = `<span class="at-req">🔒 ${req.label}</span>` +
          (progTxt ? `<span class="at-req-num">${progTxt}</span>` : '') +
          trialNote +
          (prog > 0 ? `<span class="at-prog"><span class="at-fill" style="width:${Math.round(prog * 100)}%"></span><em>${Math.round(prog * 100)}%</em></span>` : '');
        tile.appendChild(lock);
      }
      host.appendChild(tile);
    }
  }

  /** Armory tab plumbing (ARSENAL ⇄ OPERATORS). */
  bindArmoryTabs() {
    if (this._armoryTabsBound) return;
    this._armoryTabsBound = true;
    const a = $('armory-tab-arsenal'), o = $('armory-tab-operators');
    const show = (which) => {
      const arsenal = which === 'arsenal';
      $('armory-list').classList.toggle('hidden', !arsenal);
      $('operator-list').classList.toggle('hidden', arsenal);
      if (a) { a.classList.toggle('active', arsenal); a.setAttribute('aria-selected', String(arsenal)); }
      if (o) { o.classList.toggle('active', !arsenal); o.setAttribute('aria-selected', String(!arsenal)); }
      if (arsenal) this.buildArmoryPanel(); else this.buildOperatorPanel();
    };
    if (a) a.addEventListener('click', () => show('arsenal'));
    if (o) o.addEventListener('click', () => show('operators'));
  }

  /** Phase 15: ARMORY deep entry — opens the armory on a specific tab. */
  openArmory(tab = 'arsenal') {
    this.bindArmoryTabs();
    this.showScreen('armory');
    const el = $(tab === 'operators' ? 'armory-tab-operators' : 'armory-tab-arsenal');
    if (el) el.click();
  }

  buildArmoryPanel() {
    const host = $('armory-list');
    const g = this.game, pr = g && g.progress;
    if (!host || !pr) return;
    host.innerHTML = '';
    const equippedId = pr.equippedWeaponId;
    for (const id of ARMORY_ORDER) {
      const d = WEAPON_DEFS[id];
      const req = WEAPON_UNLOCKS[id];
      if (!d || !req) continue;
      const unlocked = pr.weaponUnlocked(id);
      const prog = unlocked ? 1 : unlockProgress('weapon', id, pr.data);
      const tile = document.createElement('div');
      tile.className = 'armory-tile' + (unlocked ? '' : ' locked') + (equippedId === id ? ' equipped' : '');
      tile.setAttribute('role', 'listitem');

      const head = document.createElement('div');
      head.className = 'at-head';
      head.innerHTML = `<span class="at-name">${d.name}</span><span class="at-klass">${d.klass}</span>`;
      tile.appendChild(head);

      const bars = document.createElement('div');
      bars.className = 'at-bars';
      const norm = (v, max) => Math.max(0.04, Math.min(1, v / max));
      const rows = [
        ['DMG', norm(d.damage * (d.pellets || 1), 110)],
        ['RPM', norm(d.rpm, 1000)],
        ['RNG', norm(d.falloff ? d.falloff.far : 60, 320)],
        ['CTRL', norm(1 - (d.recoil ? d.recoil.kickPitch / (16 * Math.PI / 180) : 0.5), 1)],
      ];
      for (const [label, w] of rows) {
        const row = document.createElement('div');
        row.className = 'at-row';
        row.innerHTML = `<span class="at-lbl">${label}</span><span class="at-track"><span class="at-fill" style="width:${Math.round(w * 100)}%"></span></span>`;
        bars.appendChild(row);
      }
      tile.appendChild(bars);

      const meta = document.createElement('div');
      meta.className = 'at-meta';
      meta.textContent = d.noReload
        ? `${d.magSize} RND TOTAL · CONTINUOUS FEED · ${d.weight.toFixed(1)} KG`
        : d.reloadStyle === 'shell'
          ? `${d.magSize} RND · ${d.reload.tactical.toFixed(1)}S/SHELL · ${d.weight.toFixed(1)} KG`
          : `${d.magSize} RND · ${d.reload.tactical.toFixed(1)}S RELOAD · ${d.weight.toFixed(1)} KG`;
      tile.appendChild(meta);

      if (unlocked) {
        const btn = document.createElement('button');
        btn.className = 'menu-btn at-equip' + (equippedId === id ? ' equipped-state' : '');
        btn.type = 'button';
        btn.textContent = equippedId === id ? '✓ EQUIPPED' : 'EQUIP';
        btn.disabled = equippedId === id;
        btn.addEventListener('click', () => {
          if (!pr.equipWeapon(id)) return;
          // armory selection drives the operational loadout (sidearm → secondary)
          const field = (d.sidearm || d.klass === 'SIDEARM') ? 'secondary' : 'primary';
          g.loadout.set(field, id);
          g.loadout.save();
          this.toastBrief(d.name + ' EQUIPPED AS ' + field.toUpperCase());
          this._loBuilt && this.syncLoadoutPanel();
          this.buildArmoryPanel(); // re-render states
        });
        tile.appendChild(btn);
      } else {
        const lock = document.createElement('div');
        lock.className = 'at-lock';
        const progTxt = unlockProgressText(CHARACTER_UNLOCKS[id] ? 'character' : 'weapon', id, pr.data);
        lock.innerHTML = `<span class="at-req">🔒 ${req.label}</span>` +
          (progTxt ? `<span class="at-req-num">${progTxt}</span>` : '') +
          (prog > 0 ? `<span class="at-prog"><span class="at-fill" style="width:${Math.round(prog * 100)}%"></span><em>${Math.round(prog * 100)}%</em></span>` : '');
        tile.appendChild(lock);
      }
      host.appendChild(tile);
    }
  }

  buildLoadoutPanel() {
    const lo = this.game.loadout;
    const p = $('lo-primary');
    if (!lo || !p || this._loBuilt) return;
    this._loBuilt = true;
    const s = $('lo-secondary'), t = $('lo-throwable'), tc = $('lo-tcount'), u = $('lo-utility'), uc = $('lo-ucount');
    const fill = (sel, ids, labeler) => {
      sel.innerHTML = '';
      for (const id of ids) {
        const o = document.createElement('option');
        o.value = id; o.textContent = labeler(id);
        sel.appendChild(o);
      }
    };
    // Armory roster items appear only once unlocked; campaign-issue defs
    // (VX-12, MPX-5) stay available exactly as they were before Phase 14.
    const pr = this.game.progress;
    const visible = id => CAMPAIGN_ONLY.includes(id) || !pr || pr.weaponUnlocked(id);
    fill(p, lo.primaries().filter(visible), id => WEAPON_DEFS[id].name + ' · ' + WEAPON_DEFS[id].klass);
    fill(s, lo.secondaries().filter(visible), id => WEAPON_DEFS[id].name);
    fill(t, lo.throwables(), id => THROWABLE_DEFS[id].name);
    fill(u, lo.utilities(), id => THROWABLE_DEFS[id].name);
    tc.innerHTML = '';
    for (let i = 0; i <= 3; i++) { const o = document.createElement('option'); o.value = String(i); o.textContent = '×' + i; tc.appendChild(o); }
    uc.innerHTML = '';
    for (let i = 0; i <= 2; i++) { const o = document.createElement('option'); o.value = String(i); o.textContent = '×' + i; uc.appendChild(o); }
    const bind = (el, field, parse) => {
      el.addEventListener('change', () => {
        lo.set(field, parse ? parse(el.value) : el.value);
        this.syncLoadoutPanel();
      });
    };
    bind(p, 'primary'); bind(s, 'secondary'); bind(t, 'throwable'); bind(u, 'utility');
    bind(tc, 'throwableCount', v => parseInt(v, 10) | 0);
    bind(uc, 'utilityCount', v => parseInt(v, 10) | 0);
    this.syncLoadoutPanel();
  }

  syncLoadoutPanel() {
    const lo = this.game.loadout;
    const p = $('lo-primary');
    if (!lo) return;
    if (!this._loBuilt) { this.buildLoadoutPanel(); return; }
    if (!p) return;
    p.value = lo.primary; $('lo-secondary').value = lo.secondary;
    $('lo-throwable').value = lo.throwable; $('lo-tcount').value = String(lo.throwableCount);
    $('lo-utility').value = lo.utility; $('lo-ucount').value = String(lo.utilityCount);
    const msg = lo.validate();
    $('lo-weight').textContent = 'CARRY ' + lo.weight().toFixed(1) + ' / ' + CARRY_BUDGET.toFixed(1);
    const m = $('lo-msg');
    const pr2 = this.game.progress;
    const lockedNote = (pr2 && lo.primary && !CAMPAIGN_ONLY.includes(lo.primary) && !pr2.weaponUnlocked(lo.primary))
      ? 'SELECTED PRIMARY LOCKED — EQUIP VIA ARMORY · ' : '';
    m.textContent = lockedNote + (msg || 'LOADOUT VALID — CLEAR TO DEPLOY');
    m.className = (msg || lockedNote) ? 'lo-bad' : 'lo-ok';
  }

  /**
   * Phase-14 tactical kit chips: barrier wall + operator ability status.
   * Visible only when the kit is relevant (never lands as permanent clutter):
   *  - chip hidden when nothing deployed, fully cooled, and no ability flag
   *  - ACTIVE while deployed/running, countdown numbers while cooling
   */
  refreshTacticalChips() {
    const g = this.game;
    const host = $('tac-kit');
    if (!host || !g.shield || !g.characters) return;
    const sc = $('kit-shield'), ab = $('kit-ability'), ad = $('kit-ads');
    let any = false;
    // Phase 15: live ADS indicator — visible exactly while the sights are down.
    if (ad) {
      const aiming = !!(g.weapons && g.weapons.adsT > 0.35);
      ad.className = 'kit-chip ready' + (aiming ? '' : ' hidden');
      if (aiming) any = true;
    }
    if (sc) {
      // Master upgrade P5: inventory readout — carried/capacity, walls out,
      // walls lost, plus the HP of the wall you are looking at (recoverable).
      const s = g.shield;
      const full = s.hudText ? s.hudText() : 'BARRIER';          // full detail (aria/title)
      const tgt = s.targetedUnit && g.state === 'playing' ? s.targetedUnit(6) : null;
      // CRITICAL FIX: pack + hand count; HELD state with its HP; pick-up prompt
      const withP = s.withPlayerCount != null ? s.withPlayerCount : s.carriedCount;
      const held = s.heldUnit;
      let txt = held ? `SHIELD ${Math.ceil(held.hp)} · ${withP}/3` : `BARRIER ${withP}/3`;
      if (s.deployedCount) txt += ` · ${s.deployedCount} OUT`;
      if (tgt && tgt.dist <= 2.8) txt = `${s.keyHint ? s.keyHint() : '[V]'} PICK UP ${Math.ceil(tgt.unit.hp)}`;
      const cls = held ? 'active' : withP === 0 ? (s.deployedCount ? 'active' : 'cooling') : (s.deployedCount ? 'active' : 'ready');
      if (this._c.shieldChip !== txt + cls) { this._c.shieldChip = txt + cls; sc.textContent = txt; sc.className = 'kit-chip ' + cls; }
      const aria = full + (held ? ' — TAP V TO PLANT, HOLD V TO STOW' : '') + (tgt ? ` · AIMED WALL ${Math.ceil(tgt.unit.hp)} HP${tgt.dist <= 2.8 ? ' — PRESS V TO PICK UP' : ' — MOVE CLOSER TO PICK UP'}` : '');
      sc.setAttribute('aria-label', aria); sc.title = aria;
      if (s.deployedCount || held || withP < 3) any = true;
    }
    if (ab) {
      const c = g.characters;
      const a = c.abilityDef;
      if (!a) {
        ab.textContent = (c.def && c.def.name) || 'OPERATOR';
        ab.className = 'kit-chip';
      } else {
        any = true;
        if (c.active) {
          ab.textContent = `${a.name} ${Math.max(0, Math.ceil(c.active.dur - c.active.t))}S`;
          ab.className = 'kit-chip active';
        } else if (c.cooldownLeft > 0) {
          ab.textContent = `${a.name} ${Math.ceil(c.cooldownLeft)}S`;
          ab.className = 'kit-chip cooling';
        } else if (c.charges <= 0) {
          ab.textContent = `${a.name} DEPLETED`;
          ab.className = 'kit-chip cooling';
        } else {
          ab.textContent = `${a.name} [L] ×${c.charges}`;
          ab.className = 'kit-chip ready';
        }
      }
    }
    // Tactical chips: flashlight / torch, zoom, base strike
    const lt = $('kit-light'), zm = $('kit-zoom'), sk = $('kit-strike');
    if (lt) {
      const on = !!(g.flashlight && g.flashlight.on);
      lt.textContent = on ? 'TORCH ON [F]' : 'TORCH [F]';
      lt.className = 'kit-chip' + (on ? ' active' : '');
      any = true;
    }
    if (zm) {
      const z = g.weapons && g.weapons.zoomFactor > 1.02 ? g.weapons.zoomFactor : 0;
      zm.textContent = z ? 'ZOOM ' + z.toFixed(1) + '×' : 'ZOOM';
      zm.className = 'kit-chip' + (z ? ' active' : ' hidden');
      if (z) any = true;
    }
    if (sk) {
      const b = g.baseStrike;
      if (b && b.state !== 'unavailable') {
        sk.textContent = b.hudText();
        sk.className = 'kit-chip ' + (b.state === 'ready' ? 'ready' : b.state === 'complete' ? 'cooling' : 'active');
        any = true;
      } else sk.className = 'kit-chip hidden';
    }
    host.classList.toggle('hidden', !any && !(g.characters && g.characters.abilityDef));
  }

  /**
   * Master upgrade P7 — confirmed elimination. Called ONLY from the
   * authoritative kill branch (EnemyManager.damage, once per enemy). Up to 3
   * lines stack; older lines are recycled so bursts never overlap/unreadable.
   */
  killConfirm(info = {}) {
    const host = this._killHost || (this._killHost = document.getElementById('kill-feed'));
    if (!host) return;
    this.killConfirmCount = (this.killConfirmCount || 0) + 1;
    while (host.childElementCount >= 3) host.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'kill-item';
    el.textContent = 'KILLED';
    if (info.headshot) { const s = document.createElement('span'); s.className = 'kill-sub'; s.textContent = 'HEADSHOT'; el.appendChild(s); }
    if (info.total) { const n = document.createElement('span'); n.className = 'kill-n'; n.textContent = '#' + info.total; el.appendChild(n); }
    host.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => { if (el.isConnected) el.remove(); }, 2200);   // safety if animations are disabled
  }
  clearKillFeed() { const host = document.getElementById('kill-feed'); if (host) host.textContent = ''; }

  refreshShield() { this.refreshTacticalChips(); }
  refreshAbilityHud() { this.refreshTacticalChips(); }

  /**
   * Phase-14 tactical markers: projects live enemy telemetry (tracker
   * passive trails / specialist deep-pulse reveal) onto the screen using the
   * real camera. Pool of 8 zero-alloc nodes; hidden when no fresh signal.
   */
  updateTacticalMarkers(telemetry, dt) {
    const host = $('tac-markers');
    if (!host) return;
    if (!this._tacNodes) {
      this._tacNodes = [];
      for (let i = 0; i < 8; i++) {
        const el = document.createElement('div');
        el.className = 'tac-marker';
        el.style.display = 'none';
        host.appendChild(el);
        this._tacNodes.push(el);
      }
    }
    const fresh = telemetry && (telemetry.age || 0) < 0.8;
    if (!fresh || !telemetry.list.length) { for (const n of this._tacNodes) n.style.display = 'none'; return; }
    const cam = this.game.camera;
    _tacV.set(0, 0, 0);
    let used = 0;
    for (const e of telemetry.list) {
      if (used >= this._tacNodes.length) break;
      _tacV.copy(e.screenPos);
      const behind = _tacV.z > 1;
      if (behind) _tacV.set(Math.sign(-_tacV.x || 1) * 0.97, Math.max(-0.93, Math.min(0.93, -_tacV.y)), 1);
      const x = Math.max(2, Math.min(98, (_tacV.x * 0.5 + 0.5) * 100));
      const y = Math.max(3, Math.min(95, (-_tacV.y * 0.5 + 0.5) * 100));
      const n = this._tacNodes[used++];
      n.style.display = 'block';
      n.style.left = x + '%';
      n.style.top = y + '%';
      n.className = 'tac-marker' + (e.glimpsed ? ' passive' : '');
      n.textContent = `▾ ${String(e.kind || 'HOSTILE').toUpperCase()} ${Math.round(e.dist)}M`;
    }
    for (let i = used; i < this._tacNodes.length; i++) this._tacNodes[i].style.display = 'none';
  }

  // ---- vehicle HUD (C2) ----
  showVehicleHUD(v) {
    if (!this.vehHud) return;
    this.vehHud.classList.remove('hidden');
    this.vehHud.dataset.vehicle = v.isHelicopter ? 'helicopter' : 'ground';
    this.vehName.textContent = v.def.name;
    if (this.vehControls) {
      this.vehControls.textContent = v.isHelicopter
        ? 'SPACE — ASCEND · SHIFT — DESCEND · V — HOVER · C — CAMERA · F — EXIT'
        : `W/S — THROTTLE · A/D — STEER · SPACE — BRAKE · ${v.lowRangeCapable ? 'SHIFT — LOW-RANGE 4WD · ' : ''}T — HORN · C — CAMERA · F — EXIT`;
    }
  }

  updateVehicleHUD(v) {
    if (!this.vehHud || this.vehHud.classList.contains('hidden')) return;
    this.vehKmh.textContent = String(Math.round(Math.abs(v.speed) * 3.6));
    this.vehGear.textContent = v.isHelicopter
      ? (v.landed ? 'LND' : v.hoverAltitude != null ? 'HVR' : 'AIR')
      : v.lowRange ? '4L' : (v.speed > 0.5 ? 'D' : (v.speed < -0.5 ? 'R' : 'N'));
    const altitude = Math.max(0, Number(v.pos && v.pos.y) || 0);
    if (this.vehAltitude) this.vehAltitude.textContent = `ALT ${altitude.toFixed(1)} M`;
    if (this.vehSeats) {
      const capacity = Math.max(1, v.capacity || v.def.passengers || 1);
      const occupants = THREE.MathUtils.clamp(v.occupants || (v.driver ? 1 : 0), 0, capacity);
      this.vehSeats.textContent = `SEATS ${Math.round(occupants)}/${capacity}`;
    }
    const f = Math.max(0, v.hp / v.def.hp);
    this.vehDmgFill.style.width = (f * 100).toFixed(0) + '%';
    this.vehDmgFill.className = 'bar-fill' + (f > 0.6 ? '' : f > 0.25 ? ' mid' : ' low');
    this.vehHint.textContent = v.hp <= 0 ? 'DISABLED' : (f < 0.25 ? 'SEVERELY DAMAGED' : f < 0.6 ? 'DAMAGED' : 'OPERATIONAL');
  }

  hideVehicleHUD() {
    if (this.vehHud) this.vehHud.classList.add('hidden');
  }

  /* FINAL MOBILE UX FIX — one render per brief. Before: the text went to the
   * subtitle line AND a per-frame loop re-asserted it into #interact-prompt
   * for 1.6 s (same message twice on screen, with a bogus [F] key-cap, and any
   * real door/terminal prompt overwritten). Briefs are gameplay feedback, not
   * dialogue captions, so they show even with subtitles off. `_briefMsg` stays
   * as a read-only record of the last brief (diagnostics/tests). */
  toastBrief(text, secs = 1.6) {
    this._briefMsg = text;
    this._note('BRIEF', text, Math.max(2.4, secs + 1.6), true);
  }

  hitMarker(kill) {
    this.hitmarker.classList.remove('hidden');
    this.hitmarker.classList.add('show');
    this.hitmarker.classList.toggle('kill', !!kill);
    this._hitmarkerT = kill ? 0.28 : 0.14;
  }

  playerDamaged(amount, fromPos, playerPos) {
    // red flash scaled by damage
    const f = Math.min(1, amount / 40);
    this.damageFlash.style.transition = 'none';
    this.damageFlash.style.opacity = String(0.25 + f * 0.6);
    requestAnimationFrame(() => {
      this.damageFlash.style.transition = 'opacity 350ms ease-out';
      this.damageFlash.style.opacity = '0';
    });

    if (fromPos) {
      // directional indicator: angle of attacker relative to view direction
      const dx = fromPos.x - playerPos.x;
      const dz = fromPos.z - playerPos.z;
      const bearingToAttacker = Math.atan2(dx, -dz);            // 0 = north
      const viewBearing = -this.game.player.yaw;                 // player forward bearing
      let rel = bearingToAttacker - viewBearing;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      const slot = this._dmgPool.find(d => d.t <= 0) || this._dmgPool[0];
      slot.t = 1.2;
      slot.el.style.transform = `translate(-50%,-50%) rotate(${rel}rad)`;
      slot.el.style.opacity = '1';
    }
  }

  setLockdown(seconds) {
    if (seconds <= 0) {
      this.lockdownEl.classList.add('hidden');
      return;
    }
    this.lockdownEl.classList.remove('hidden');
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const txt = `LOCKDOWN T-${m}:${s.toString().padStart(2, '0')}`;
    if (this._c.lockdown !== txt) {
      this.lockdownEl.textContent = txt;
      this._c.lockdown = txt;
    }
  }

  setInteract(prompt) {
    if (prompt) {
      this.interactPrompt.classList.remove('hidden');
      if (this._c.prompt !== prompt) {
        this.interactText.textContent = prompt;
        this._c.prompt = prompt;
      }
    } else {
      this.interactPrompt.classList.add('hidden');
      this._c.prompt = null;
    }
  }

  setHackProgress(p, label) {
    if (p === null) {
      this.hackProgress.classList.add('hidden');
    } else {
      this.hackProgress.classList.remove('hidden');
      this.hackFill.style.width = `${Math.round(p * 100)}%`;
      if (label && this._c.hackLabel !== label) {
        $('hack-label').textContent = label;
        this._c.hackLabel = label;
      }
    }
  }

  // -------------------------------------------------------------------------
  /** Called every rendered frame while playing. */
  // ------------------------------------------------------------------
  // Progress counters now live in the dedicated profile view, not the main menu.
  refreshMenuBadges() { /* retained for existing callers; no menu clutter */ }

  syncSelectScreen() {
    const pr = this.game && this.game.progress;
    if (!pr) return;
    const done = pr.completedCount();
    const frontierId = pr.frontierMissionId();
    const frontierDef = MISSION_DEFS[frontierId] || {};
    const fIdx = MISSION_ORDER.indexOf(frontierId);
    const summaryEl = $('select-campaign-summary');
    if (summaryEl) {
      summaryEl.textContent = `CAMPAIGN PROGRESS: ${done} / ${MISSION_ORDER.length} COMPLETED · ACTIVE FRONTIER: OP ${String(fIdx + 1).padStart(3, '0')} — ${frontierDef.title || frontierId.toUpperCase()}`;
    }
    for (let i = 0; i < 10; i++) {
      const id = MISSION_ORDER[i];
      const btn = $('btn-mission-' + id);
      if (!btn) continue;
      const unlocked = pr.isMissionUnlocked(id);
      const rec = pr.data.missions && pr.data.missions[id];
      const minE = getMissionMinEnemies(i + 1);
      btn.classList.toggle('locked', !unlocked);
      let badge = btn.querySelector('.mc-prog-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mc-prog-badge';
        btn.appendChild(badge);
      }
      if (!unlocked) {
        const reqId = pr.unlockRequirement(id);
        const reqDef = MISSION_DEFS[reqId] || {};
        badge.className = 'mc-prog-badge mc-lock';
        badge.textContent = `OP ${String(i + 1).padStart(3, '0')} · ${minE} HOSTILES · LOCKED (COMPLETE ${reqDef.title || reqId})`;
      } else if (rec && rec.completed) {
        badge.className = 'mc-prog-badge mc-clear';
        badge.textContent = `OP ${String(i + 1).padStart(3, '0')} · ${minE} HOSTILES · COMPLETE ★ ${rec.bestRating || ''}`;
      } else {
        badge.className = 'mc-prog-badge mc-clear';
        badge.textContent = `OP ${String(i + 1).padStart(3, '0')} · ${minE} HOSTILES · READY TO DEPLOY`;
      }
    }
  }

  buildMissionsList() {
    const pr = this.game.progress;
    const el = $('missions-list');
    if (!el) return;
    el.innerHTML = '';

    // Build persistent filter toolbar in #missions-toolbar (so typing in search doesn't lose focus!)
    const tb = $('missions-toolbar');
    if (tb && !tb._built) {
      tb._built = true;
      const summary = document.createElement('div');
      summary.id = 'missions-prog-summary';
      summary.className = 'campaign-summary';
      tb.appendChild(summary);

      const chips = document.createElement('div');
      chips.id = 'missions-act-chips';
      chips.className = 'cat-chips';
      tb.appendChild(chips);

      const row = document.createElement('div');
      row.className = 'missions-filter-row';

      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'missions-search';
      search.placeholder = 'SEARCH OP #, CODENAME, LOCATION, OR CATEGORY...';
      search.value = this._missionSearch || '';
      search.addEventListener('input', () => {
        this._missionSearch = search.value;
        this._renderMissionsRows();
      });

      const envSel = document.createElement('select');
      envSel.className = 'missions-env-select';
      const allOpt = document.createElement('option');
      allOpt.value = 'ALL';
      allOpt.textContent = 'ALL 20 ENVIRONMENT CATEGORIES';
      envSel.appendChild(allOpt);
      for (const catObj of Object.values(ENVIRONMENT_CATEGORIES)) {
        const opt = document.createElement('option');
        opt.value = catObj.id;
        opt.textContent = catObj.label;
        envSel.appendChild(opt);
      }
      envSel.value = this._missionEnv || 'ALL';
      envSel.addEventListener('change', () => {
        this._missionEnv = envSel.value;
        this._renderMissionsRows();
      });

      row.appendChild(search);
      row.appendChild(envSel);
      tb.appendChild(row);
    }

    const sumEl = $('missions-prog-summary');
    if (sumEl) {
      const done = pr.completedCount();
      const frontId = pr.frontierMissionId();
      const fIdx = MISSION_ORDER.indexOf(frontId);
      const fDef = MISSION_DEFS[frontId] || {};
      sumEl.textContent = `CAMPAIGN PROGRESS: ${done} / ${MISSION_ORDER.length} COMPLETED · NEXT OPERATION: OP ${String(fIdx + 1).padStart(3, '0')} — ${fDef.title || frontId}`;
    }

    const chipsHost = $('missions-act-chips');
    if (chipsHost) {
      chipsHost.innerHTML = '';
      const tabs = [
        { key: 'ALL', label: `ALL (${MISSION_ORDER.length})` },
        { key: 'UNLOCKED', label: 'UNLOCKED' },
        ...CAMPAIGN_ACTS.map(a => ({ key: `ACT_${a.act}`, label: `${a.code} (${a.range[0]}–${a.range[1]})` })),
      ];
      const curTab = this._missionActTab || 'ALL';
      for (const t of tabs) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cat-chip' + (curTab === t.key ? ' on' : '');
        chip.textContent = t.label;
        chip.addEventListener('click', () => {
          this._missionActTab = t.key;
          this.buildMissionsList();
        });
        chipsHost.appendChild(chip);
      }
    }

    this._renderMissionsRows();
  }

  _renderMissionsRows() {
    const pr = this.game.progress;
    const el = $('missions-list');
    if (!el) return;
    el.innerHTML = '';
    const curTab = this._missionActTab || 'ALL';
    const curEnv = this._missionEnv || 'ALL';
    const q = (this._missionSearch || '').trim().toLowerCase();
    const frontierId = pr.frontierMissionId();
    const diff = ((pr && pr.data.difficulty) || this.game.settings.difficulty || 'standard').toUpperCase();

    let shown = 0;
    for (let idx = 0; idx < MISSION_ORDER.length; idx++) {
      const id = MISSION_ORDER[idx];
      const def = MISSION_DEFS[id];
      if (!def) continue;
      const mNum = idx + 1;
      const opCode = `OP ${String(mNum).padStart(3, '0')}`;
      const unlocked = pr.isMissionUnlocked(id);
      if (curTab === 'UNLOCKED' && !unlocked) continue;
      if (curTab.startsWith('ACT_')) {
        const wantAct = Number(curTab.slice(4));
        if ((def.act || Math.ceil(mNum / 20)) !== wantAct) continue;
      }
      if (curEnv !== 'ALL' && def.category !== curEnv) continue;
      if (q) {
        const hay = `${opCode} ${mNum} ${def.title || ''} ${def.categoryLabel || ''} ${def.loc || ''} ${def.tag || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      shown++;
      const rec = pr.data.missions[id];
      const minE = def.minEnemies || getMissionMinEnemies(mNum);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mission-row' + (unlocked ? '' : ' locked');
      const reqId = pr.unlockRequirement(id);
      const reqIdx = reqId ? MISSION_ORDER.indexOf(reqId) : -1;
      const reqCode = reqIdx >= 0 ? `OP ${String(reqIdx + 1).padStart(3, '0')}` : '?';
      const status = !unlocked
        ? `<span class="m-status lock">LOCKED — COMPLETE ${reqCode}</span>`
        : rec && rec.completed
          ? `<span class="m-status">COMPLETE ★ ${rec.bestRating}</span>`
          : id === frontierId
            ? '<span class="m-status frontier">ACTIVE FRONTIER ▸</span>'
            : '<span class="m-status">AVAILABLE</span>';
      const medals = rec && rec.bestMedals && rec.bestMedals.length
        ? ' · 🏅 ' + rec.bestMedals.length : '';
      const envLabel = def.categoryLabel || def.cat || 'CAMPAIGN';
      const locShort = (def.loc || '').split('—')[1]?.trim() || def.loc || def.map.toUpperCase();
      row.innerHTML = `<span class="m-main"><span class="m-title"><span class="m-code">${opCode}</span>${def.title}</span>` +
        `<span class="m-tag">${envLabel} · ${locShort}</span>` +
        `<span class="m-tag">MIN HOSTILES: ${minE} · DIFFICULTY ${diff} · ${def.vehicle ? 'VEHICLE OP' : 'ON FOOT'}${medals}</span>` +
        `</span>${status}`;
      row.addEventListener('click', () => this.showBrief(id, 'missions'));
      el.appendChild(row);
    }
    if (shown === 0) {
      const empty = document.createElement('div');
      empty.className = 'm-tag';
      empty.style.padding = '18px';
      empty.textContent = 'NO OPERATIONS MATCH CURRENT FILTER.';
      el.appendChild(empty);
    }
  }

  /** Pre-deploy briefing screen (spec §29) — works on mobile via .brief-panel CSS. */
  showBrief(id, origin) {
    const def = MISSION_DEFS[id];
    if (!def) return;
    this._briefId = id;
    this._briefOrigin = origin || 'select';
    const g = this.game;
    const pr = g.progress;
    const mIdx = MISSION_ORDER.indexOf(id);
    const opCode = mIdx >= 0 ? `OP ${String(mIdx + 1).padStart(3, '0')} / ${MISSION_ORDER.length}` : 'TRAINING';
    const minE = mIdx >= 0 ? (def.minEnemies || getMissionMinEnemies(mIdx + 1)) : 30;
    $('brief-title').textContent = mIdx >= 0 ? `OP ${String(mIdx + 1).padStart(3, '0')} — ${def.title}` : def.title;
    $('brief-meta').innerHTML =
      `<span>OPERATION <b>${opCode}</b></span>` +
      `<span>LOCATION <b>${def.loc || (def.map || '').toUpperCase()}</b></span>` +
      `<span>ENVIRONMENT <b>${def.categoryLabel || def.cat || 'TACTICAL'}</b></span>` +
      `<span>HOSTILE FORCE <b>${minE}+ ARMED HOSTILES</b></span>` +
      `<span>TIME / WX <b>${def.time || '—'} · ${def.wx || '—'}</b></span>` +
      `<span>DIFFICULTY <b>${((pr && pr.data.difficulty) || g.settings.difficulty || 'standard').toUpperCase()} · PAR ${def.parTime ? def.parTime + 's' : '—'}</b></span>`;
    $('brief-body').textContent = def.brief ||
      'Execute the operation as briefed. Follow the objective marker and extract when complete.';
    const obj = $('brief-objectives');
    let html = '<h3>PRIMARY OBJECTIVES</h3><ul>';
    const steps = def.seq || [];
    for (const st of steps) {
      if (st.opt) continue;
      html += `<li>${st.text}</li>`;
    }
    if (!steps.length) html += '<li>COMPLETE THE OPERATION AND REACH EXTRACTION</li>';
    html += '</ul>';
    const OPT_NAMES = {
      ghost: 'RAISE NO ALARM', intel: 'RECOVER ALL INTEL', par: 'FINISH UNDER PAR TIME',
      light: 'MINIMIZE CASUALTIES', marksman: 'MARKSMAN ACCURACY',
    };
    if (def.optionals && def.optionals.length) {
      html += '<h3>OPTIONAL OBJECTIVES</h3><ul>';
      for (const o of def.optionals) html += `<li class="opt">${OPT_NAMES[o] || String(o).toUpperCase()}</li>`;
      html += '</ul>';
    }
    obj.innerHTML = html;
    const unlocked = pr ? pr.isMissionUnlocked(id) : true;
    const startBtn = $('btn-brief-start');
    if (startBtn) {
      startBtn.disabled = !unlocked;
      if (!unlocked) {
        const reqId = pr.unlockRequirement(id);
        const reqIdx = reqId ? MISSION_ORDER.indexOf(reqId) : -1;
        const reqDef = (reqId && MISSION_DEFS[reqId]) || {};
        startBtn.textContent = `LOCKED — COMPLETE OP ${String(reqIdx + 1).padStart(3, '0')}: ${reqDef.title || reqId}`;
      } else {
        startBtn.textContent = 'DEPLOY ▸';
      }
    }
    const priorClear = !!(pr && pr.data.missions[id] && pr.data.missions[id].completed);
    const reward = priorClear
      ? 'REPLAY · FIRST-CLEAR MISSION XP ALREADY CLAIMED. ONLY NEW MEDALS CAN AWARD XP.'
      : (def.reward || 'XP · CAMPAIGN PROGRESSION');
    $('brief-reward').innerHTML = '<h3>REWARDS</h3>' + reward;
    this.showScreen('brief');
  }

  /** Pause-menu panels: objective sequence + current equipment (spec §43). */
  buildObjectivesPanel() {
    const g = this.game;
    const el = $('objectives-list');
    const title = document.querySelector('#screen-objectives .panel-title');
    if (title) title.textContent = 'MISSION OBJECTIVES';
    if (!el) return;
    el.innerHTML = '';
    const m = g.missions;
    const def = m.def;
    const rows = [];
    const steps = (m.isSeq && def && def.seq) ? def.seq : null;
    if (steps) {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        rows.push({ text: st.text, state: i < m.seqIdx ? 'done' : i === m.seqIdx ? 'current' : 'next' });
      }
    } else if (g.state === 'playing') {
      rows.push({ text: (this._objSubBase || def.title || 'COMPLETE THE OPERATION').toUpperCase(), state: 'current' });
    }
    const op = m.currentObjectivePos ? m.currentObjectivePos() : null;
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'obj-row ' + r.state;
      const mark = r.state === 'done' ? '✓' : r.state === 'current' ? '▶' : '◇';
      let dist = '';
      if (r.state === 'current' && op) {
        const d = Math.round(Math.hypot(op.x - g.player.pos.x, op.z - g.player.pos.z));
        dist = `<span class="obj-dist">${d} m</span>`;
      }
      div.innerHTML = `<span class="obj-mark">${mark}</span><span>${r.text}</span>${dist}`;
      el.appendChild(div);
    }
    if (!rows.length) el.innerHTML = '<div class="obj-row"><span>NO ACTIVE OPERATION</span></div>';
  }

  buildEquipmentPanel() {
    const g = this.game;
    const el = $('objectives-list');
    const title = document.querySelector('#screen-objectives .panel-title');
    if (title) title.textContent = 'EQUIPMENT / LOADOUT';
    if (!el) return;
    const ws = g.weapons;
    const defs = ws.defs || {};
    const lo = g.loadout || {};
    const wname = (id) => (defs[id] ? defs[id].name + ' · ' + defs[id].klass : (id || '—').toUpperCase());
    const line = (slot, txt) => `<div class="obj-row"><span class="obj-mark">■</span><span>${slot}: <b>${txt}</b></span></div>`;
    const cur = ws.state[ws.currentId] || {};
    let html = '';
    html += line('IN HAND', wname(ws.currentId));
    html += line('PRIMARY', wname(lo.primary));
    html += line('SECONDARY', wname(lo.secondary));
    const th = g.throwables;
    if (th && th.count) {
      const tnames = ['vxfrag', 'smoke', 'flash', 'decoy', 'flare', 'sensor', 'breach']
        .map(id => ((THROWABLE_DEFS[id] && THROWABLE_DEFS[id].name) || id.toUpperCase()) + ' ×' + th.count(id))
        .filter(x => !/×0$/.test(x));
      html += `<div class="obj-row"><span class="obj-mark">●</span><span>THROWABLES: <b>${tnames.length ? tnames.join(' · ') : 'EMPTY'}</b></span></div>`;
      html += `<div class="obj-row"><span class="obj-mark">◇</span><span>UTILITY: MEDKIT ×${th.count('medkit') || 0}</span></div>`;
    }
    html += `<div class="obj-row"><span class="obj-mark">Σ</span><span>AMMO: <b>${cur.mag != null ? cur.mag : '—'}</b> IN MAG · ${cur.reserve != null ? cur.reserve : '—'} RESERVE</span></div>`;
    html += `<div class="obj-row"><span class="obj-mark">i</span><span>SWAP GEAR IN THE FIELD: WEAPON PICKUPS, SUPPLY CRATES, VEHICLE TRUNKS (HOLD INTERACT)</span></div>`;
    el.innerHTML = html;
  }

  buildLoadoutList() {
    const pr = this.game.progress;
    const el = $('loadout-list');
    if (!el) return;
    el.innerHTML = '';
    for (const f of FINISHES) {
      const unlocked = pr.finishUnlocked(f.id);
      const equipped = pr.data.finish === f.id;
      const row = document.createElement('button');
      row.className = 'list-row' + (unlocked ? '' : ' locked');
      const swatch = f.color === null ? '#23262a' : '#' + f.color.toString(16).padStart(6, '0');
      row.innerHTML = `<span style="width:14px;height:14px;background:${swatch};border:1px solid rgba(255,255,255,0.25);display:inline-block"></span>` +
        `<span class="m-main"><span class="m-title">${f.name}</span></span>` +
        `<span class="m-status${unlocked ? '' : ' lock'}">${equipped ? 'EQUIPPED' : unlocked ? 'SELECT' : 'LOCKED — RANK ' + RANKS[f.rank].name}</span>`;
      if (unlocked && !equipped) {
        row.addEventListener('click', () => {
          pr.setFinish(f.id);
          this.game.weapons.applyFinish();
          this.buildLoadoutList();
        });
      }
      el.appendChild(row);
    }
  }

  buildIntelList() {
    const pr = this.game.progress;
    const el = $('intel-list');
    if (!el) return;
    el.innerHTML = '';
    const MAP_NAMES = { facility: 'KESTREL YARD', snow: 'WHITEOUT RELAY', desert: 'DUSTBOWL CACHE', urban: 'GREYLINE DISTRICT', metro: 'GREYLINE METRO', industrial: 'COLD FORGE WORKS', rural: 'OUTSKIRTS' };
    for (const map of Object.keys(MAP_NAMES)) {
      const total = pr.intelTotal(map);
      if (!total) continue;
      const found = pr.intelFoundOn(map);
      const h = document.createElement('div');
      h.className = 'intel-map';
      h.textContent = `${MAP_NAMES[map]} — ${found} / ${total} RECOVERED`;
      el.appendChild(h);
      for (let i = 0; i < total; i++) {
        const it = document.createElement('div');
        const got = pr.isIntelFound(map, i);
        it.className = 'intel-item' + (got ? ' found' : '');
        it.textContent = got ? pr.intelFoundLabel(map, i) : 'UNRECOVERED DOCUMENT';
        el.appendChild(it);
      }
    }
  }

  buildAwardsList() {
    const pr = this.game.progress;
    const el = $('awards-list');
    if (!el) return;
    el.innerHTML = '';
    for (const m of MEDALS) {
      const earned = pr.data.medals.includes(m.id);
      const card = document.createElement('div');
      card.className = 'medal-card' + (earned ? ' earned' : '');
      card.innerHTML = `<span class="medal-icon">🎖</span><div class="medal-name">${m.name}</div><div class="medal-desc">${m.desc}</div>`;
      el.appendChild(card);
    }
  }

  buildStatsList() {
    const pr = this.game.progress;
    const s = pr.data.stats;
    const el = $('stats-list');
    if (!el) return;
    const xp = Math.max(0, Number(pr.data.xp) || 0);
    const next = pr.nextRank;
    const pct = Math.max(0, Math.min(100, Math.round(pr.rankProgress * 100)));
    const xpRemaining = next ? Math.max(0, next.xp - xp) : 0;
    const hrs = Math.floor(s.playTime / 3600), mins = Math.floor((s.playTime % 3600) / 60);
    const acc = s.shots > 0 ? Math.round(s.hits / s.shots * 100) : 0;
    const tutorialState = pr.data.tutorialCompleted ? 'COMPLETE · REPLAY ANYTIME' : 'NOT COMPLETED';
    const rows = [
      ['DIFFICULTY', pr.difficulty.name],
      ['MISSION RUNS CLEARED', s.missionsCompleted],
      ['MISSIONS FAILED', s.missionsFailed],
      ['TOTAL PLAY TIME', hrs + 'h ' + mins + 'm'],
      ['PRIMARY OBJECTIVES', s.objectivesCompleted],
      ['OPTIONAL OBJECTIVES', s.optionalCompleted],
      ['INTEL DISCOVERED', s.intelFound],
      ['MEDALS EARNED', pr.data.medals.length + ' / ' + MEDALS.length],
      ['SHOTS FIRED', s.shots],
      ['SHOTS HIT', s.hits + ' (' + acc + '%)'],
      ['HEADSHOTS', s.headshots],
      ['HOSTILES NEUTRALISED', s.kills],
      ['DAMAGE TAKEN', Math.round(s.damageTaken)],
      ['SUCCESSFUL EXTRACTIONS', s.extractions],
      ['STEALTH COMPLETIONS', s.stealthCompletions],
      ['CHECKPOINTS USED', s.checkpointsUsed],
      ['BEST PERFORMANCE', s.bestRating + ' / 100'],
    ];
    const progressLabel = next ? `NEXT RANK · ${next.name}` : 'MAXIMUM RANK';
    const progressValue = next ? `${xpRemaining.toLocaleString()} XP TO GO` : 'ALL RANKS EARNED';
    el.innerHTML = `
      <section class="profile-overview" aria-label="Progression overview">
        <div class="profile-topline">
          <div><span class="profile-caption">CURRENT RANK</span><strong class="profile-rank">${pr.rank.name}</strong></div>
          <div class="profile-xp"><strong>${xp.toLocaleString()}</strong><span>XP</span></div>
        </div>
        <div class="profile-progress-meta"><span>${progressLabel}</span><span>${progressValue}</span></div>
        <div class="profile-xp-bar" role="progressbar" aria-label="Progress to next rank" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-valuetext="${pct} percent">
          <i style="width:${pct}%"></i>
        </div>
        <div class="profile-milestones">
          <div><strong>${pr.completedCount()} / ${MISSION_ORDER.length}</strong><span>CAMPAIGN OPS</span></div>
          <div><strong>${pr.intelGrandFound()} / ${pr.intelGrandTotal()}</strong><span>INTEL</span></div>
          <div><strong>${pr.data.medals.length} / ${MEDALS.length}</strong><span>AWARDS</span></div>
        </div>
        <p class="profile-tutorial-state">FIELD TUTORIAL · ${tutorialState}</p>
      </section>
      <div class="stat-grid">${rows.map(r => `<span class="s-label">${r[0]}</span><span class="s-val">${r[1]}</span>`).join('')}</div>`;
  }

  _tutorialSteps() {
    const touch = !!this.game._touchPrimary;
    return [
      {
        title: 'MOVE & LOOK',
        desktop: 'Move with W, A, S, D (arrow keys also work). Move the mouse to look. Click the game view if it asks to capture the mouse; press Escape to pause or release it.',
        mobile: 'Use the left-side movement stick and drag on the right-side look area. Use both at once: move with one thumb while turning with the other.',
        desktopHint: 'Shift sprints · Ctrl crouches · Space jumps.',
        mobileHint: 'SPRINT, CROUCH and JUMP are separate buttons. Handedness and control placement are adjustable in Settings.',
      },
      {
        title: 'AIM & FIRE',
        desktop: 'Hold the right mouse button to aim down sights; left-click to fire. You can keep aiming while you shoot.',
        mobile: 'Use ADS to aim and FIRE to shoot. Keep the movement stick engaged while the other thumb aims or fires.',
        desktopHint: 'Aim behavior can be changed in Settings.',
        mobileHint: 'Aim behavior follows AIM BUTTON MODE in Settings (hold or toggle).',
      },
      {
        title: 'RELOAD & SELECT GEAR',
        desktop: 'Press R to reload or clear a stoppage. Press 1 or 2 for your primary or secondary weapon, 3 for a throwable, and 4 for utility.',
        mobile: 'Tap RELOAD to refill. Tap SWAP to switch weapons. Hold EQP for the equipment wheel; ITEM cycles weapon, throwable and utility.',
        desktopHint: 'Check magazine and reserve ammunition in the HUD.',
        mobileHint: 'The weapon and ammunition HUD stays visible while you practice.',
      },
      {
        title: 'EQUIPMENT & SUPPLIES',
        desktop: 'Hold Q for the equipment wheel. G cycles the selected item; use the fire button to throw or activate it. Hold F when a supply prompt requests an interaction.',
        mobile: 'Hold EQP for the equipment wheel. ITEM cycles weapon, throwable and utility; FIRE uses the selected item. Tap USE near a supply prompt and keep holding while progress fills.',
        desktopHint: 'Hold H to apply a bandage. Release when the action is complete.',
        mobileHint: 'The range supply crate is reusable and restores ammunition.',
      },
      {
        title: 'OBJECTIVES & TACTICAL MAP',
        desktop: 'Follow the objective card and marker. Press M for the tactical map. Press F at an interaction prompt; hold it when a progress bar appears. Mission briefs show primary and optional tasks.',
        mobile: 'Follow the objective on the HUD. Tap MAP for the tactical map; tap USE at an interaction prompt and keep holding if a progress bar appears. Campaign and Missions contain the operation briefs.',
        desktopHint: 'Campaign operations end after their required objectives and extraction are complete.',
        mobileHint: 'Primary objectives and extraction are required; optional tasks are labeled separately.',
      },
      {
        title: 'COVER & SURVIVAL',
        desktop: 'Use solid walls, crates and terrain to break enemy sightlines. Crouch with Ctrl, watch alert and damage cues, and change position instead of staying exposed.',
        mobile: 'Move between solid cover; use CROUCH and SPRINT to reposition. Watch your health and alert cues. You can move while the other thumb looks or aims.',
        desktopHint: 'Use the health and armor indicators to judge when to take cover or treat an injury.',
        mobileHint: 'Health, armor and ammunition remain available in the touch HUD.',
      },
      {
        title: 'PRACTICE & DEPLOY',
        desktop: 'The range has paper targets at marked distances, unlimited ammunition and a reusable supply crate. Practice movement, aim and reload here; deploy through Campaign or Missions when ready.',
        mobile: 'Practice on the range targets, with unlimited ammunition and a reusable supply crate. When ready, deploy through Campaign or Missions and follow the on-screen objectives to extraction.',
        desktopHint: 'Replay this guide from Training or Settings. Adjust controls, difficulty, text size, contrast and motion in Settings.',
        mobileHint: 'Replay this guide from Training or Settings. Customize the mobile layout, handedness, text size, contrast and motion in Settings.',
      },
    ];
  }

  showTutorial(origin = 'menu') {
    this._tutorialOrigin = this.screens[origin] ? origin : 'menu';
    this._tutorialStep = 0;
    this.renderTutorial();
    this.showScreen('tutorial');
  }

  renderTutorial() {
    const steps = this._tutorialSteps();
    const touch = !!this.game._touchPrimary;
    const step = steps[this._tutorialStep] || steps[0];
    const completed = !!this.game.progress.data.tutorialCompleted;
    const mode = $('tutorial-mode');
    if (mode) mode.textContent = `${touch ? 'TOUCH CONTROLS' : 'KEYBOARD + MOUSE'}${completed ? ' · REPLAY' : ''}`;
    const progress = $('tutorial-progress');
    if (progress) progress.textContent = `STEP ${this._tutorialStep + 1} OF ${steps.length}`;
    $('tutorial-step-title').textContent = step.title;
    $('tutorial-step-body').textContent = touch ? step.mobile : step.desktop;
    $('tutorial-step-hint').textContent = touch ? step.mobileHint : step.desktopHint;
    const prev = $('btn-tutorial-prev');
    prev.disabled = this._tutorialStep === 0;
    const next = $('btn-tutorial-next');
    next.textContent = this._tutorialStep === steps.length - 1 ? 'COMPLETE & START RANGE' : 'NEXT';
    next.setAttribute('aria-label', this._tutorialStep === steps.length - 1
      ? 'Complete the tutorial and start the training range' : `Continue to tutorial step ${this._tutorialStep + 2}`);
    const back = $('btn-tutorial-back');
    const backLabels = { menu: 'BACK TO MAIN MENU', settings: 'BACK TO SETTINGS', pause: 'BACK TO PAUSE', stats: 'BACK TO PROFILE' };
    back.textContent = backLabels[this._tutorialOrigin] || 'BACK';
  }

  previousTutorialStep() {
    this._tutorialStep = Math.max(0, this._tutorialStep - 1);
    this.renderTutorial();
  }

  nextTutorialStep() {
    const last = this._tutorialSteps().length - 1;
    if (this._tutorialStep >= last) {
      this.game.progress.markTutorialCompleted();
      this.game.startMission('range');
      return;
    }
    this._tutorialStep++;
    this.renderTutorial();
  }

  closeTutorial() {
    const origin = this.screens[this._tutorialOrigin] ? this._tutorialOrigin : 'menu';
    this.showScreen(origin);
  }

  /** post-mission debrief: objectives, performance, medals, XP, unlocks */
  showDebrief(result, def, ctx) {
    const pr = this.game.progress;
    const body = $('debrief-body');
    const acc = ctx.shots > 0 ? Math.round(ctx.hits / ctx.shots * 100) : 0;
    const mm = Math.floor(ctx.timeSec / 60), ss = Math.floor(ctx.timeSec % 60);
    const optLines = (ctx.optionals || []).map(o =>
      `<div class="debrief-row"><span>${o.text}</span><b class="${o.done ? 'ok' : 'bad'}">${o.done ? '✓ DONE' : '✗ MISSED'}</b></div>`).join('');
    const medalChips = result.allMedals.map(id => {
      const m = MEDALS.find(x => x.id === id);
      const isNew = result.newMedals.includes(id);
      return `<span class="medal-chip${isNew ? ' new' : ''}">${m ? m.name : id}</span>`;
    }).join('') || '<span class="debrief-row">NO MEDALS THIS RUN</span>';
    const unlocks = result.unlocks.map(x => `<div class="unlock-line">UNLOCKED — ${x}</div>`).join('');
    body.innerHTML = `
      <div class="debrief-sec">
        <h3>MISSION</h3>
        <div class="debrief-row"><span>${def.title}</span><b>${(def.type || 'infiltration').toUpperCase()} · ${pr.difficulty.name}</b></div>
        <div class="debrief-row"><span>STATUS</span><b class="ok">COMPLETE — EXTRACTED</b></div>
      </div>
      <div class="debrief-sec">
        <h3>OBJECTIVES</h3>
        <div class="debrief-row"><span>PRIMARY OBJECTIVES</span><b class="ok">✓ ${ctx.objectivesDone}/${ctx.objectivesTotal}</b></div>
        <div class="debrief-row"><span>OPTIONAL OBJECTIVES</span><b>${ctx.optionalDone}/${ctx.optionalTotal}</b></div>
        ${optLines}
      </div>
      <div class="debrief-sec">
        <h3>PERFORMANCE</h3>
        <div class="debrief-row"><span>ACCURACY</span><b>${acc}% (${ctx.hits}/${ctx.shots})</b></div>
        <div class="debrief-row"><span>CONFIRMED ELIMINATIONS</span><b>${(this.game.stats && this.game.stats.kills) || 0}</b></div>
        ${this.game.baseStrike && this.game.baseStrike.structures.length ? `<div class="debrief-row"><span>ENEMY BASE</span><b class="${this.game.stats.baseDestroyed ? 'ok' : ''}">${this.game.stats.baseDestroyed ? 'DESTROYED' + (this.game.stats.baseStrikeKills ? ' · ' + this.game.stats.baseStrikeKills + ' HOSTILES' : '') : 'INTACT'}</b></div>` : ''}
        <div class="debrief-row"><span>DAMAGE TAKEN</span><b>${Math.round(ctx.damageTaken)}</b></div>
        <div class="debrief-row"><span>TIME</span><b>${mm}:${ss.toString().padStart(2, '0')}${ctx.parTime ? ' · PAR ' + ctx.parTime + 's' : ''}</b></div>
        <div class="debrief-row"><span>ALERT LEVEL</span><b class="${ctx.alarm ? 'bad' : 'ok'}">${ctx.alarm ? 'MAJOR ALERT TRIGGERED' : 'GHOST — NO MAJOR ALERT'}</b></div>
        <div class="debrief-row"><span>INTELLIGENCE</span><b>${ctx.intelFound}/${ctx.intelTotal}</b></div>
        <div class="debrief-row"><span>CHECKPOINTS USED</span><b>${ctx.checkpointsUsed}</b></div>
      </div>
      <div class="rating-big"><div class="r-num">${result.rating}</div><div class="r-label">PERFORMANCE RATING</div></div>
      <div class="debrief-sec">
        <h3>AWARDS</h3>
        <div class="medal-strip">${medalChips}</div>
      </div>
      <div class="debrief-sec xp-strip">
        <h3>PROGRESSION</h3>
        <div class="debrief-row"><span>${result.repeatCompletion ? 'XP AWARDED' : 'XP GAINED'}</span><b>+${result.xp}</b></div>
        ${result.repeatCompletion ? '<p class="debrief-note">REPEAT CLEAR · FIRST-CLEAR MISSION XP IS NOT REPEATED. NEW MEDALS MAY STILL EARN XP.</p>' : ''}
        <div class="debrief-row"><span>RANK</span><b>${pr.rank.name}${result.rankUp ? ' → ' + result.rankUp : ''}</b></div>
        <div class="xp-bar"><i style="width:${Math.round(pr.rankProgress * 100)}%"></i></div>
        ${unlocks}
      </div>`;
    this.showScreen('complete');
  }

  armorFlash() {
    if (this._armorFlashT > 0) return;
    this._armorFlashT = 0.35;
    this.armorFlashEl();
  }
  armorFlashEl() { if (this.armorFill) this.armorFill.classList.add('flash'); }

  toggleTacMap() {
    if (this.game.tacmap) this.game.tacmap.toggle();
  }
  closeTacMap() {
    if (this.game.tacmap) this.game.tacmap.close(true);
  }

  _drawCompass(dt = 0) {
    const ctx = this.compassCtx;
    if (!ctx) return;
    const g = this.game, p = g.player;
    const W = 440, cx = W / 2, ppd = 2.9;
    const cb = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    this._compassDrawTimer -= dt;
    const prev = this._compassDrawnBearing;
    const delta = prev == null ? Infinity : Math.abs(((cb - prev + 540) % 360) - 180);
    if (this._compassDrawTimer > 0 && delta < 2) return;
    this._compassDrawTimer = 0.1;
    this._compassDrawnBearing = cb;
    ctx.clearRect(0, 0, W, 36);
    ctx.textAlign = 'center';
    for (let t = 0; t < 360; t += 7.5) {
      const d = ((t - cb + 540) % 360) - 180;
      if (Math.abs(d) > 74) continue;
      const x = cx + d * ppd;
      const major = t % 90 === 0, mid = t % 45 === 0;
      ctx.strokeStyle = major ? 'rgba(220,240,225,0.9)' : mid ? 'rgba(180,210,190,0.55)' : 'rgba(150,180,160,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, major ? 15 : mid ? 12 : 10); ctx.stroke();
      if (major) {
        const lbl = t === 0 ? 'N' : t === 90 ? 'E' : t === 180 ? 'S' : 'W';
        ctx.font = 'bold 10px monospace';
        ctx.fillStyle = 'rgba(225,245,230,0.95)';
        ctx.fillText(lbl, x, 27);
      } else if (mid) {
        ctx.font = '8px monospace';
        ctx.fillStyle = 'rgba(170,200,180,0.6)';
        ctx.fillText(String(t), x, 26);
      }
    }
    const tgt = g.missions.compassTarget ? g.missions.compassTarget() : null;
    if (tgt) {
      const dx = tgt.x - p.pos.x, dz = tgt.z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      const tb = ((Math.atan2(dx, -dz) * 180 / Math.PI) % 360 + 360) % 360;
      const d = ((tb - cb + 540) % 360) - 180;
      const xe = Math.max(12, Math.min(W - 12, cx + d * ppd));
      const onStrip = Math.abs(d) <= 74;
      ctx.fillStyle = onStrip ? '#ffd479' : 'rgba(255,212,121,0.5)';
      ctx.beginPath();
      ctx.moveTo(xe, 1); ctx.lineTo(xe + 5, 7); ctx.lineTo(xe, 13); ctx.lineTo(xe - 5, 7);
      ctx.closePath(); ctx.fill();
      if (onStrip) {
        ctx.font = '8px monospace';
        ctx.fillText(Math.round(dist) + 'm', xe, 35);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, 3); ctx.lineTo(cx, 17); ctx.stroke();
  }

  /* FINAL MOBILE UX FIX — one render per radio call. Before: the radio pill
   * AND a [COMMS] subtitle showed the identical text at the same time. Now:
   * subtitles ON → the caption line ([COMMS]); subtitles OFF → the radio pill. */
  radio(text) {
    if (this.game.settings && this.game.settings.subtitles !== false) { this._note('COMMS', text, 3.6, false); return; }
    if (!this.radioEl) return;
    const t = '▸ ' + text;
    if (this._radioT > 0 && this.radioEl.textContent === t) { this._radioT = Math.max(this._radioT, 3.2); return; }   // same call repeated → extend, no re-render
    this.radioEl.textContent = t;
    this.radioEl.classList.add('show');
    this._radioT = 3.2;
    this._radioRenders = (this._radioRenders || 0) + 1;
  }

  /** Subtitle line for comms / briefings / important updates (spec §47). */
  subtitle(tag, text, secs = 4) { this._note(tag, text, secs, false); }

  /* The single renderer for the notification line (#subtitle-line).
   *  - identical tag+text while it is still showing (or already queued) →
   *    the timer is extended; nothing is drawn twice
   *  - a DIFFERENT message that arrives within NOTE_MIN_HOLD (1 s) of the
   *    current one is queued (max 2) instead of overwriting it, so two
   *    legitimate back-to-back events both stay readable — without growing a
   *    second row over the HUD lanes. `force` = show even with subtitles off. */
  _note(tag, text, secs = 4, force = false) {
    if (!force && this.game.settings && !this.game.settings.subtitles) return;
    const el = $('subtitle-line');
    if (!el) return;
    const key = tag + '\u0001' + text;
    this._noteQ = this._noteQ || [];
    if (this._subT > 0 && this._noteKey === key) { this._subT = Math.max(this._subT, secs); return; }
    const q = this._noteQ.find(n => n.key === key);
    if (q) { q.secs = Math.max(q.secs, secs); return; }
    if (this._subT > 0 && (this._noteShown || 0) < 1.0) {
      this._noteQ.push({ key, tag, text, secs });
      if (this._noteQ.length > 2) this._noteQ.shift();
      return;
    }
    this._showNote({ key, tag, text, secs });
  }
  _showNote(n) {
    const el = $('subtitle-line');
    if (!el) return;
    $('subtitle-tag').textContent = '[' + n.tag + ']';
    $('subtitle-text').textContent = n.text;
    el.classList.remove('hidden');
    this._noteKey = n.key;
    this._noteShown = 0;
    this._subT = n.secs;
    this._noteRenders = (this._noteRenders || 0) + 1;   // diagnostics: one per distinct message
  }
  setPinned(on) {
    if (!this.pinnedEl) return;
    this.pinnedEl.classList.toggle('show', !!on);
  }

  // -------------------------------------------------------------------------
  // Cache-guarded DOM writes.
  // updateHUD runs every frame; touching the DOM unconditionally is one of the
  // few things that can cost more than the render itself on a phone. Each of
  // these skips the write when the value has not changed.
  // -------------------------------------------------------------------------
  _text(key, el, value) {
    if (!el || this._c[key] === value) return;
    this._c[key] = value;
    el.textContent = value;
  }
  _style(key, el, prop, value) {
    if (!el || this._c[key] === value) return;
    this._c[key] = value;
    el.style[prop] = value;
  }
  _flag(key, el, cls, on) {
    if (!el || this._c[key] === on) return;
    this._c[key] = on;
    el.classList.toggle(cls, on);
  }

  updateHUD(dt) {
    const g = this.game;
    const p = g.player;
    const ws = g.weapons;

    // Phase-14 tactical chips: 5 Hz is plenty for second-resolution status.
    this._kitT = (this._kitT || 0) - dt;
    if (this._kitT <= 0) { this._kitT = 0.2; this.refreshTacticalChips(); }

    // notification line: auto-hide, then hand over to a queued message
    if (this._subT > 0) {
      this._subT -= dt;
      this._noteShown = (this._noteShown || 0) + dt;
      const q = this._noteQ;
      if (q && q.length && (this._subT <= 0 || this._noteShown >= 1.0)) this._showNote(q.shift());
      else if (this._subT <= 0) { const sl = $('subtitle-line'); if (sl) sl.classList.add('hidden'); this._noteKey = null; }
    }

    // Dynamic next-action guidance and meta for active mission
    if (g.missions && g.missions.stage) {
      const ms = g.missions;
      const def = ms.def || {};
      const orderIdx = MISSION_ORDER.indexOf(ms.missionId);
      const opNum = orderIdx >= 0 ? `OP ${String(orderIdx + 1).padStart(3, '0')}/${MISSION_ORDER.length}` : 'TRAINING';
      const stepsDone = ms.isSeq ? (ms.seqIdx || 0) : (ms.stageIndex || 0);
      const stepsTotal = (def.seq ? def.seq.filter(s => !s.opt).length : def.objectivesTotal) || 5;
      const metaTxt = orderIdx >= 0
        ? `${opNum} · ${def.title || 'MISSION'} [${stepsDone}/${stepsTotal}]`
        : 'TRAINING RANGE';
      if (this.objMeta && this._c.objMeta !== metaTxt) {
        this.objMeta.textContent = metaTxt;
        this._c.objMeta = metaTxt;
      }

      // Live hostile / wave counter on HUD (hidden on firing range)
      if (this.objHostiles) {
        if (ms.missionId === 'range') {
          this._flag('hostilesHidden', this.objHostiles, 'hidden', true);
        } else {
          this._flag('hostilesHidden', this.objHostiles, 'hidden', false);
          const rem = g.enemies ? g.enemies.remainingHostiles : 0;
          const tot = g.enemies ? g.enemies.totalMissionEnemies : (def.minEnemies || 50);
          const kls = (g.stats && g.stats.kills) || 0;
          const hTxt = rem > 0
            ? `HOSTILES: ${rem} REMAINING / ${tot} TOTAL · ELIMINATED: ${kls}`
            : `SECTOR CLEAR — ${kls}/${tot} HOSTILES NEUTRALIZED`;
          this._text('hostilesTxt', this.objHostiles, hTxt);
          this._flag('hostilesClear', this.objHostiles, 'clear', rem === 0);
        }
      }

      // Context-aware plain-language next action
      let actionTxt = '';
      const stKey = ms.stage;
      if (stKey === 'approach') {
        actionTxt = 'NEXT ACTION: Move toward compound gate · Stay low & avoid sentries';
      } else if (stKey === 'enter') {
        actionTxt = 'NEXT ACTION: Infiltrate interior perimeter · Locate terminal';
      } else if (stKey === 'clear') {
        const remaining = g.enemies ? g.enemies.remainingHostiles : 0;
        actionTxt = `NEXT ACTION: Neutralize all hostiles in sector (${remaining} remaining)`;
      } else if (stKey === 'locate') {
        actionTxt = 'NEXT ACTION: Approach console and hold [F] to download data';
      } else if (stKey === 'escape') {
        actionTxt = 'NEXT ACTION: Push through exit alley · Alarm is active';
      } else if (stKey === 'extract') {
        actionTxt = 'NEXT ACTION: Reach marked extraction LZ · Press [M] for map';
      } else if (ms.isSeq && def.seq) {
        const step = def.seq[ms.seqIdx];
        if (step) {
          if (step.kind === 'reach') actionTxt = `NEXT ACTION: Move to ${step.text || 'waypoint'} · Check [M] for map`;
          else if (step.kind === 'interact') actionTxt = `NEXT ACTION: Approach ${step.target || 'target'} and hold [F]`;
          else if (step.kind === 'destroy') actionTxt = 'NEXT ACTION: Destroy marked target hardware with gunfire or explosives';
          else if (step.kind === 'capture') actionTxt = 'NEXT ACTION: Hold inside the marked command ring until 100%';
          else if (step.kind === 'eliminate' || step.kind === 'eliminate_count') actionTxt = 'NEXT ACTION: Sweep & eliminate hostile forces · Follow compass';
          else if (step.kind === 'board') actionTxt = 'NEXT ACTION: Approach mission vehicle and hold [F] to board';
          else if (step.kind === 'drive') actionTxt = 'NEXT ACTION: Drive vehicle to the marked rally / objective zone';
          else if (step.kind === 'collect') actionTxt = `NEXT ACTION: Collect evidence markers [${g.world.evidenceCollected || 0}/${step.n || 3}]`;
          else if (step.kind === 'escort' || step.kind === 'escort_veh') actionTxt = 'NEXT ACTION: Escort allied asset safely to the destination';
          else if (step.kind === 'survive') actionTxt = 'NEXT ACTION: Hold ground against incoming waves';
          else if (step.kind === 'extract') actionTxt = 'NEXT ACTION: Stand on the green extraction LZ';
        }
      }
      if (this.objAction && this._c.objAction !== actionTxt) {
        this.objAction.textContent = actionTxt;
        this._c.objAction = actionTxt;
      }
    }

    // live distance + compass direction to the CURRENT objective (spec §26)
    if (g.missions && g.missions.currentObjectivePos && this.objSub) {
      const op = g.missions.currentObjectivePos();
      if (op) {
        const dx = op.x - p.pos.x, dz = op.z - p.pos.z;
        const dist = Math.round(Math.hypot(dx, dz));
        let ang = Math.atan2(dx, -dz) * 180 / Math.PI;   // 0 = north (-Z), clockwise
        if (ang < 0) ang += 360;
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const dir = dirs[Math.round(ang / 45) % 8];
        const txt = dist + ' m · ' + dir;
        if (txt !== this._objDist) {
          this._objDist = txt;
          this.objSub.textContent = (this._objSubBase ? this._objSubBase + ' · ' : '') + txt + ' · [M] MAP';
        }
      } else if (this._objDist) {
        this._objDist = '';
        this.objSub.textContent = this._objSubBase || '';
      }
    }

    // timers
    if (this._radioT > 0) {
      this._radioT -= dt;
      if (this._radioT <= 0) this.radioEl.classList.remove('show');
    }
    this._text('frags', this.fragEl, 'FRAG ×' + (p.frags || 0));
    if (this.armorFill) {
      this._style('armor', this.armorFill, 'width',
                  Math.max(0, Math.min(100, Math.round(p.armor || 0))) + '%');
      if (this._armorFlashT > 0) {
        this._armorFlashT -= dt;
        if (this._armorFlashT <= 0) this.armorFill.classList.remove('flash');
      }
    }
    if (this.armorRow) this._flag('armorRowHidden', this.armorRow, 'hidden', !(p.armor > 0));
    const mobileStamina = !!g._touchPrimary && (!!p.sprinting || !!p.exhausted || p.stamina < 45);
    if (this._c.mobileStamina !== mobileStamina) {
      this._c.mobileStamina = mobileStamina;
      document.body.classList.toggle('mobile-stamina-show', mobileStamina);
    }
    if (this.bandageEl) {
      const bandaging = p.bandageT > 0.05;
      this.bandageEl.classList.toggle('hidden', !bandaging);
      if (bandaging && this.bandageFill) this.bandageFill.style.width = (p.bandageT / 2.8 * 100) + '%';
    }
    this._drawCompass(dt);
    if (!this._zoomFrame) this._zoomFrame = document.getElementById('zoom-frame');
    this._flag('zoomFrame', this._zoomFrame, 'on', !!(ws && ws.zoomT > 0.4));
    const tm = g.tacmap;
    // v4.4: while the map is up it repaints itself from the game loop (game.js calls
    // render2D), so the HUD must not draw the same frame a second time.
    if (tm) { if (!tm.open) tm.drawMini(); }
    const lvl = g.enemies.alertLevel || 'unaware';
    if (lvl !== this._alertLvl) {
      this._alertLvl = lvl;
      if (this.alertChip) {
        this.alertChip.textContent = lvl.toUpperCase();
        this.alertChip.className = lvl === 'unaware' ? 'hidden' : lvl;
      }
    }
    if (this._toastT > 0) {
      this._toastT -= dt;
      if (this._toastT <= 0) this.toastEl.classList.remove('show');
    }
    if (this._hitmarkerT > 0) {
      this._hitmarkerT -= dt;
      if (this._hitmarkerT <= 0) { this.hitmarker.classList.remove('show'); this.hitmarker.classList.add('hidden'); }
    }
    for (const d of this._dmgPool) {
      if (d.t > 0) {
        d.t -= dt;
        if (d.t <= 0) d.el.style.opacity = '0';
      }
    }
    // (FINAL MOBILE UX FIX: the per-frame brief → #interact-prompt re-assert
    //  was removed — briefs render once, on the notification line.)

    // ammo / weapon
    const st = ws.st, def = ws.def;
    const ammoHud = ammoHudState(def, st);
    const total = ammoHud.total;
    if (this._c.mag !== st.mag) { this.ammoMag.textContent = String(st.mag); this._c.mag = st.mag; }
    const resTxt = (def.id === 'lb9' && st.freeAllowance != null)
      ? `${st.reserve} [${st.freeAllowance}/100 FREE]`
      : String(st.reserve);
    if (this._c.res !== resTxt) { this.ammoReserve.textContent = resTxt; this._c.res = resTxt; }
    this._flag('ammoLow', this.ammoMag, 'low', st.mag <= def.magSize * 0.25);
    // §13: auto-suggest reload when the magazine runs dry — one-shot toast +
    // pulsing RELOAD button on touch (never blocking)
    const rldBtn = this._rldBtn || (this._rldBtn = document.getElementById('tbtn-reload'));
    const suggest = ammoHud.suggestReload && g.handsMode === 'gun';
    if (suggest) {
      this._flag('rldSuggest', rldBtn, 'suggest', true);
      if (!this._dryWarned) { this._dryWarned = true; this.toastBrief('MAGAZINE EMPTY — RELOAD'); }
    } else {
      this._flag('rldSuggest', rldBtn, 'suggest', false);
      if (st.mag > 0 || def.noReload) this._dryWarned = false;
    }
    // total rounds + reload state (C3)
    if (this._c.total !== total) {
      if (this.ammoTotal) this.ammoTotal.textContent = 'Σ ' + total;
      this._c.total = total;
    }
    // throwable / utility row
    const th = g.throwables;
    if (th && this.throwRow) {
      const tid = th.equipped || 'vxfrag';
      const tName = THROWABLE_DEFS[tid] ? THROWABLE_DEFS[tid].name : '—';
      let txt = tName + ' ×' + th.count(tid);
      if (th.utility && THROWABLE_DEFS[th.utility]) txt += '   ·   ' + THROWABLE_DEFS[th.utility].name + ' ×' + th.count(th.utility);
      this._text('throwTxt', this.throwRow, txt);
      this._flag('throwHidden', this.throwRow, 'hidden', false);
      this._flag('hlThrow', this.throwRow, 'hl-throw', g.handsMode === 'throwable');
      this._flag('hlUtil', this.throwRow, 'hl-util', g.handsMode === 'utility');
    }
    // flashbang whiteout decay
    if (this._fb > 0) {
      this._fb = Math.max(0, this._fb - dt * 1.05);
      if (this.flashbangEl) this.flashbangEl.style.opacity = this._fb.toFixed(3);
    }
    if (this._c.wpn !== ws.currentId) {
      this.weaponName.textContent = def.name;
      if (this.weaponClass) this.weaponClass.textContent = def.klass;
      this._c.wpn = ws.currentId;
    }
    const mode = st.fireMode || def.defaultFireMode || (def.auto ? 'auto' : 'semi');
    const modeKey = ws.currentId + ':' + mode;
    if (this.weaponMode && this._c.firemode !== modeKey) {
      const modeName = mode === 'auto' ? 'AUTO' : mode === 'burst' ? 'BURST' : 'SEMI';
      this.weaponMode.textContent = (def.fireModes && def.fireModes.length > 1) ? modeName + ' · B' : modeName;
      this.weaponMode.title = def.fireModes && def.fireModes.length > 1
        ? 'B — CHANGE FIRE MODE' : 'NO ALTERNATE FIRE MODE';
      this.weaponMode.setAttribute('aria-label', 'Fire mode: ' + modeName + (def.fireModes && def.fireModes.length > 1 ? '. Press B or tap to change.' : '.'));
      this.weaponMode.disabled = !(def.fireModes && def.fireModes.length > 1);
      this._c.firemode = modeKey;
    }
    let stateTxt = '';
    if (ws.state_ === 'reloading' && !def.noReload) stateTxt = st.malf ? 'RACKING BOLT' : ws._shellReload ? 'LOADING SHELLS' : 'RELOADING';
    else if (st.malf && !def.noReload) stateTxt = 'MALFUNCTION — R TO CLEAR';
    else if (def.noReload && total === 0) stateTxt = ammoHud.noReloadMessage;
    else if (st.mag === 0 && !def.noReload) stateTxt = 'MAGAZINE EMPTY — R';
    else if (p.armInjury > 0) stateTxt = 'HANDLING IMPAIRED';
    else if (def.noReload) stateTxt = ammoHud.noReloadMessage;
    if (this._c.wstate !== stateTxt) { this.weaponState.textContent = stateTxt; this._c.wstate = stateTxt; }

    // vitals
    const hp = Math.ceil(p.health);
    if (this._c.hp !== hp) {
      this.healthFill.style.width = `${hp}%`;
      this.healthNum.textContent = String(hp);
      this._c.hp = hp;
    }
    this._flag('hpCrit', this.healthFill, 'critical', hp < 30);
    const sp = Math.floor(p.stamina);
    this._style('sp', this.staminaFill, 'width', `${sp}%`);
    this._flag('spEx', this.staminaFill, 'exhausted', !!p.exhausted);

    // low-health vignette
    const low = p.health < 45 ? (1 - p.health / 45) * 0.55 : 0;
    this._style('vig', this.vignette, 'opacity', (0.7 + low).toFixed(2));

    // In-engine 3D Picture-in-Sight Optic (LB-9 Longbow & Precision Rifles)
    const isSniper = !!(ws.def && (ws.def.klass === 'PRECISION RIFLE' || ws.def.id === 'lb9'));
    if (this.sniperOverlay) {
      if (!this.sniperOverlay.classList.contains('hidden')) {
        this.sniperOverlay.classList.add('hidden');
        this.sniperOverlay.style.opacity = '0';
      }
    }

    const isReloading = !!(ws && (ws.state_ === 'reloading' || ws.reloading));
    const isDead = p.health <= 0;

    let targetAdsMode = 'hip'; // 'hip', 'ads-standard', 'ads-sniper'
    if (!isDead && !isReloading) {
      if (isSniper) {
        if (ws.adsT > 0.08) {
          targetAdsMode = 'ads-sniper';
        }
      } else {
        if (ws.adsT > 0.55) {
          targetAdsMode = 'ads-standard';
        }
      }
    }

    if (this._c.adsMode !== targetAdsMode) {
      this._c.adsMode = targetAdsMode;
      this.crosshair.classList.toggle('ads', targetAdsMode === 'ads-standard');
      this.crosshair.classList.toggle('sniper-ads', targetAdsMode === 'ads-sniper');
    }

    const shots = g.stats.shots || 0;
    if (shots < this._crossShots) this._crossShots = shots;
    if (shots > this._crossShots) {
      this._crossShots = shots;
      this._crossFlashT = 0.085;
      this.crosshair.classList.add('fire-pulse');
    } else if (this._crossFlashT > 0) {
      this._crossFlashT -= dt;
      if (this._crossFlashT <= 0) this.crosshair.classList.remove('fire-pulse');
    }
    if (targetAdsMode === 'hip') {
      const spread = ws.currentSpreadDegrees();
      const gap = 5 + spread * 3.4;
      if (Math.abs((this._c.gap || 0) - gap) > 0.4) {
        this._c.gap = gap;
        const ticks = this.crosshair.children;
        ticks[0].style.transform = `translateY(${-gap - 7}px)`;
        ticks[1].style.transform = `translateY(${gap}px)`;
        ticks[2].style.transform = `translateX(${-gap - 7}px)`;
        ticks[3].style.transform = `translateX(${gap}px)`;
      }
    }

    // stance indicator
    let stanceTxt = '';
    if (!p.onGround) stanceTxt = 'AIRBORNE';
    else if (p.crouching) stanceTxt = 'CROUCHED';
    else if (p.sprinting) stanceTxt = 'SPRINTING';
    // CRITICAL ADS fix: nothing is drawn over the sight picture — the stance
    // chip sat just under the screen centre (the AIM kit chip already reports ADS)
    if (targetAdsMode !== 'hip') stanceTxt = '';
    if (this._c.stance !== stanceTxt) { this.stance.textContent = stanceTxt; this._c.stance = stanceTxt; }

    // fps counter (performance mode)
    this._fpsFrames++;
    this._fpsT += dt;
    if (this._fpsT >= 0.5) {
      const fps = Math.round(this._fpsFrames / this._fpsT);
      this.fps.textContent = `${fps} FPS`;
      this._fpsT = 0; this._fpsFrames = 0;
    }
    this._flag('fpsHidden', this.fps, 'hidden', !g.settings.perfMode);
    this._updateProximityAlert(dt);
  }

  _updateProximityAlert(dt) {
    const g = this.game, p = g.player;
    if (!p || !p.alive || g.state !== 'playing' || !g.enemies) {
      if (this.proxAlert && !this.proxAlert.classList.contains('hidden')) this.proxAlert.classList.add('hidden');
      if (this.threatRear && !this.threatRear.classList.contains('hidden')) this.threatRear.classList.add('hidden');
      if (this.threatLeft && !this.threatLeft.classList.contains('hidden')) this.threatLeft.classList.add('hidden');
      if (this.threatRight && !this.threatRight.classList.contains('hidden')) this.threatRight.classList.add('hidden');
      return;
    }

    this._proxTimer = (this._proxTimer || 0) - dt;
    if (this._proxTimer > 0) return;
    this._proxTimer = 0.065; // ~15 Hz cadence, highly responsive with zero lag

    const px = p.pos.x, pz = p.pos.z;
    const viewBearing = -p.yaw; // player forward heading in radians

    let nearestDist = Infinity;
    let nearestEnemy = null;
    let rearThreat = false;
    let leftThreat = false;
    let rightThreat = false;
    let attackingCount = 0;

    const list = g.enemies.list || [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive || e.fled || e.surrendered) continue;

      // Active threat filter: only alerted, combat-engaged, pursuing, or visual-contact hostiles
      // Prevents false alarms from passive guards / unaware sentries behind walls
      const isActiveThreat = e.state === 'combat' || (e.state === 'alert' && e.contactConfirmed) ||
        e.canSeePlayer || (e.hasLOS && (e.state === 'investigate' || e.state === 'search'));
      if (!isActiveThreat) continue;

      const dx = e.pos.x - px;
      const dz = e.pos.z - pz;
      const d2 = dx * dx + dz * dz;

      // Proximity threshold: within 22 meters
      if (d2 > 22 * 22) continue;

      const dist = Math.sqrt(d2);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestEnemy = e;
      }

      if (e.combatAction === 'engage' || dist < 6.5) attackingCount++;

      // Relative angle to player's camera facing
      const bearing = Math.atan2(dx, -dz);
      let rel = bearing - viewBearing;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;

      // Behind: > 100 deg (1.75 rad)
      // Left flank: -100 deg to -35 deg (-1.75 to -0.6 rad)
      // Right flank: +35 deg to +100 deg (+0.6 to +1.75 rad)
      if (Math.abs(rel) > 1.75) rearThreat = true;
      else if (rel < -0.6) leftThreat = true;
      else if (rel > 0.6) rightThreat = true;
    }

    if (nearestEnemy && nearestDist < 20) {
      const escalated = nearestDist < 7.5 || attackingCount > 0;
      let text = 'ENEMY NEARBY';
      if (escalated) {
        text = rearThreat ? 'CRITICAL: HOSTILE FLANKING REAR' : 'DANGER: HOSTILE IN CLOSE PROXIMITY';
      } else if (rearThreat) {
        text = 'WARNING: HOSTILE BEHIND';
      } else if (leftThreat || rightThreat) {
        text = 'WARNING: HOSTILE ON FLANK';
      }

      if (this.proxText) this.proxText.textContent = text;
      if (this.proxDist) this.proxDist.textContent = `[${Math.round(nearestDist)}M]`;
      if (this.proxAlert) {
        this.proxAlert.classList.remove('hidden');
        this.proxAlert.classList.toggle('escalated', escalated);
      }
      if (this.threatRear) this.threatRear.classList.toggle('hidden', !rearThreat);
      if (this.threatLeft) this.threatLeft.classList.toggle('hidden', !leftThreat);
      if (this.threatRight) this.threatRight.classList.toggle('hidden', !rightThreat);
    } else {
      if (this.proxAlert && !this.proxAlert.classList.contains('hidden')) this.proxAlert.classList.add('hidden');
      if (this.threatRear && !this.threatRear.classList.contains('hidden')) this.threatRear.classList.add('hidden');
      if (this.threatLeft && !this.threatLeft.classList.contains('hidden')) this.threatLeft.classList.add('hidden');
      if (this.threatRight && !this.threatRight.classList.contains('hidden')) this.threatRight.classList.add('hidden');
    }
  }

  // -------------------------------------------------------------------------
  showDeath(cause, hasCheckpoint) {
    $('death-cause').textContent = cause || 'You were eliminated by hostile fire.';
    $('btn-death-cp').style.display = hasCheckpoint ? '' : 'none';
    this.showScreen('death');
  }

  showFailed(reason, hasCheckpoint) {
    $('failed-reason').textContent = reason;
    $('btn-failed-cp').style.display = hasCheckpoint ? '' : 'none';
    this.showScreen('failed');
  }

  syncDifficultyControl() {
    const sel = $('set-difficulty');
    const pr = this.game.progress;
    if (sel) sel.value = pr.data.difficulty;
    const desc = $('difficulty-desc');
    if (desc) desc.textContent = pr.difficulty.desc;
  }

  /** Compact bottom navigation for touch devices (menu-side screens only). */
  _bindMobNav() {
    if (!this.mobnav) return;
    const go = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', () => {
        if (this.game.audio && this.game.audio.ready) this.game.audio.uiConfirm();
        fn();
      });
    };
    go('mn-home', () => { this.refreshMenuBadges(); this.showScreen('menu'); });
    go('mn-missions', () => { this.buildMissionsList(); this.showScreen('missions'); });
    go('mn-loadout', () => this.showScreen('select'));
    go('mn-intel', () => { this.buildIntelList(); this.showScreen('intel'); });
    go('mn-settings', () => this.showScreen('settings'));
    this._bindLobby();
    this._bindShell();
  }

  // =========================================================================
  // PHASE 09 — tactical lobby (main menu)
  // =========================================================================
  /** Founding campaign ops shown directly in the lobby — same data the ALL
      OPERATIONS screen uses, no duplicate mission definitions. */
  buildLobby() {
    const host = $('lobby-missions');
    if (!host) return;
    const g = this.game;
    const pr = g.progress;
    const frontierId = pr.frontierMissionId();
    const frontierIdx = Math.max(0, MISSION_ORDER.indexOf(frontierId));
    // Show a focused window around the operator's active campaign frontier (up to 10 cards)
    const winStart = Math.max(0, Math.min(frontierIdx - 2, MISSION_ORDER.length - 10));
    const campaign = MISSION_ORDER.slice(winStart, winStart + 10);
    if (!this._lobbyMission || MISSION_ORDER.indexOf(this._lobbyMission) < 0
        || !pr.isMissionUnlocked(this._lobbyMission)) {
      this._lobbyMission = frontierId;
    }
    host.textContent = '';
    for (const id of campaign) {
      const def = MISSION_DEFS[id];
      if (!def) continue;
      const mIdx = MISSION_ORDER.indexOf(id);
      const opCode = `OP ${String(mIdx + 1).padStart(3, '0')}`;
      const unlocked = pr.isMissionUnlocked(id);
      const rec = pr.data.missions[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lobby-mission' + (id === this._lobbyMission ? ' on' : '') + (unlocked ? '' : ' locked');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', id === this._lobbyMission ? 'true' : 'false');
      b.disabled = !unlocked;
      const status = rec && rec.completed ? ' ★' + (rec.bestRating || '') : (!unlocked ? ' 🔒' : '');
      const minE = def.minEnemies || getMissionMinEnemies(mIdx + 1);
      const tag = `${opCode} · ${minE} HOSTILES · ${(def.categoryLabel || def.tag || '').toUpperCase()}`;
      b.innerHTML = `<span class="lm-title">${def.title}${status}</span><span class="lm-tag">${tag}</span>`;
      if (unlocked) {
        b.addEventListener('click', () => {
          if (this.game.audio && this.game.audio.ready) this.game.audio.uiConfirm();
          if (this._lobbyMission !== id) { this._lobbyMission = id; this.buildLobby(); }
        });
      }
      host.appendChild(b);
    }
    const def = MISSION_DEFS[this._lobbyMission];
    const meta = $('lobby-meta');
    if (meta && def) {
      // Stage-count fallback keeps the OBJECTIVES cell truthful for missions
      // defined by a stages map rather than a seq list (KESTREL YARD etc.).
      const steps = (def.seq || []).filter((s) => !s.opt).length || def.objectivesTotal || 0;
      meta.innerHTML =
        `<span>LOCATION <b>${def.loc || (def.map || '').toUpperCase()}</b></span>` +
        `<span>TIME <b>${def.time || '—'}</b></span>` +
        `<span>WEATHER <b>${def.wx || '—'}</b></span>` +
        `<span>OBJECTIVES <b>${steps ? steps + (def.parTime ? ' · PAR ' + def.parTime + 's' : '') : (def.parTime ? 'PAR ' + def.parTime + 's' : '—')}</b></span>`;
    }
    const diffSel = $('lobby-difficulty');
    const curDiff = (g.progress && g.progress.data.difficulty) || g.settings.difficulty || 'standard';
    if (diffSel && diffSel.value !== curDiff) diffSel.value = curDiff;
    const startBtn = $('btn-lobby-start');
    if (startBtn && g.state !== 'loading') {
      startBtn.disabled = false;
      startBtn.classList.remove('launching');
      startBtn.textContent = 'DEPLOY NOW ▸';
    }
    this.buildFeatured();
  }

  // =========================================================================
  // PHASE 16 — cinematic menu shell (reference-matched chrome)
  // =========================================================================
  /** Featured-operation card on the main menu: real mission data only —
      definition (title/tag), briefing meta (loc/time/wx via #lobby-meta),
      description text reused from the SELECT BATTLEFIELD cards (no duplicate
      copy), and real stage objectives from MISSION_DEFS. */
  buildFeatured() {
    const id = this._lobbyMission;
    const def = id && MISSION_DEFS[id];
    if (!def) return;
    const mapCardBtn = $('btn-mission-' + id);
    const descEl = mapCardBtn && mapCardBtn.querySelector('.mc-desc');
    const set = (eid, txt) => { const el = $(eid); if (el) el.textContent = txt; };
    set('feat-title', def.title || '—');
    set('feat-tag', def.tag || (def.type || '').toUpperCase() || '—');
    set('feat-desc', descEl ? descEl.textContent.trim() : (def.loc || ''));
    const art = $('feat-art');
    if (art) art.dataset.map = def.map || 'facility';
    const obj = $('feat-obj');
    if (obj) {
      obj.textContent = '';
      const stages = def.stages && typeof def.stages === 'object'
        ? Object.keys(def.stages).filter((k) => k !== 'complete').slice(0, 3) : [];
      if (stages.length) {
        for (const k of stages) {
          const li = document.createElement('li');
          li.textContent = (def.stages[k] && def.stages[k].text) || k.toUpperCase();
          obj.appendChild(li);
        }
      } else if (def.objectivesTotal) {
        const li = document.createElement('li');
        li.textContent = `${def.objectivesTotal} PRIMARY OBJECTIVES · EXFILTRATE`;
        obj.appendChild(li);
      }
    }
  }

  /** Player chip in the shared topbar — real rank/XP only (no fabricated stats). */
  buildShell() {
    const pr = this.game && this.game.progress;
    if (!pr) return;
    const lvEl = $('stb-lv'), fill = $('stb-xpfill'), chip = $('shell-player');
    const idx = Math.max(0, RANKS.indexOf(pr.rank));
    const pct = Math.max(0, Math.min(100, Math.round((pr.rankProgress || 0) * 100)));
    if (lvEl) lvEl.textContent = `LV. ${idx + 1} · ${pr.rank.name}`;
    if (fill) fill.style.width = pct + '%';
    if (chip) {
      const bar = chip.querySelector('.stb-xp');
      if (bar) {
        bar.setAttribute('aria-valuenow', String(pct));
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
      }
      chip.setAttribute('aria-label', `Profile and stats — rank ${pr.rank.name}, ${pct}% to next rank`);
    }
  }

  closeDrawer() {
    if (!document.body.classList.contains('drawer-open')) return;
    document.body.classList.remove('drawer-open');
    const b = $('shell-burger');
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  _bindShell() {
    const tick = () => { if (this.game.audio && this.game.audio.ready) this.game.audio.uiConfirm(); };
    const burger = $('shell-burger');
    if (burger) {
      burger.addEventListener('click', () => {
        const open = !document.body.classList.contains('drawer-open');
        document.body.classList.toggle('drawer-open', open);
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
        tick();
      });
    }
    const scrim = $('drawer-scrim');
    if (scrim) scrim.addEventListener('click', () => this.closeDrawer());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) {
        this.closeDrawer();
        e.stopPropagation();
      }
    }, true);
    // Drawer closes whenever a destination is chosen from the sidebar.
    const drawer = $('menu-drawer');
    if (drawer) {
      drawer.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.lnv-item')) this.closeDrawer();
      });
    }
    const go = (eid, fn) => {
      const el = $(eid);
      if (el) el.addEventListener('click', () => { tick(); fn(); });
    };
    go('btn-shell-home', () => { this.refreshMenuBadges(); this.showScreen('menu'); });
    go('stb-brand', () => { this.refreshMenuBadges(); this.showScreen('menu'); });
    go('btn-shell-settings', () => { this.syncSettingsControls(this.game.settings); this.showScreen('settings'); });
    go('shell-player', () => { this.buildStatsList(); this.showScreen('stats'); });
    // Featured-operation pager: cycle the same unlocked campaign list the
    // lobby listbox uses, then refresh both widgets (single data path).
    const step = (dir) => {
      const pr = this.game.progress;
      const list = MISSION_ORDER.slice(0, 10).filter((m) => pr.isMissionUnlocked(m));
      if (!list.length) return;
      const i = Math.max(0, list.indexOf(this._lobbyMission));
      this._lobbyMission = list[(i + dir + list.length) % list.length];
      this.buildLobby();
    };
    go('feat-prev', () => step(-1));
    go('feat-next', () => step(1));
  }

  _bindLobby() {
    const startBtn = $('btn-lobby-start');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const g = this.game;
        if (g.state === 'loading') return;                 // duplicate-launch guard
        if (!this._lobbyMission) this.buildLobby();
        const id = this._lobbyMission;
        if (!id) return;
        startBtn.disabled = true;
        startBtn.classList.add('launching');
        startBtn.textContent = 'DEPLOYING…';
        // startMission already shows the staged loading screen and re-enters
        // MENU on rejection (e.g. locked); restore the button defensively.
        g.startMission(id).then(() => {
          if (g.state !== 'loading' && g.state !== 'playing') {
            startBtn.disabled = false;
            startBtn.classList.remove('launching');
            startBtn.textContent = 'DEPLOY NOW ▸';
          }
        }).catch(() => {
          startBtn.disabled = false;
          startBtn.classList.remove('launching');
          startBtn.textContent = 'DEPLOY NOW ▸';
        });
      });
    }
    const diffSel = $('lobby-difficulty');
    if (diffSel) {
      diffSel.addEventListener('change', (e) => {
        // same code path as the Settings difficulty control (canonical store)
        this.game.progress.setDifficulty(e.target.value);
        this.game.settings.difficulty = e.target.value;   // keep legacy display mirror in sync
        this.syncDifficultyControl();
        if (this.game.audio && this.game.audio.ready) this.game.audio.uiConfirm();
      });
    }
  }

  _updateMobNav(name) {
    if (!this.mobnav) return;
    const menuScreens = ['select', 'missions', 'loadout', 'intel', 'awards', 'stats', 'settings', 'credits', 'brief'];
    const show = !!this.game._touchPrimary && menuScreens.indexOf(name) >= 0;
    this.mobnav.classList.toggle('hidden', !show);
    const map = { menu: 'mn-home', missions: 'mn-missions', select: 'mn-loadout', brief: 'mn-loadout', intel: 'mn-intel', settings: 'mn-settings' };
    for (const id of ['mn-home', 'mn-missions', 'mn-loadout', 'mn-intel', 'mn-settings']) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('on', map[name] === id);
    }
  }

  syncSettingsControls(settings) {
    $('set-sens').value = settings.sensitivity;
    $('val-sens').textContent = settings.sensitivity.toFixed(2);
    $('set-fov').value = settings.fov;
    $('val-fov').textContent = String(settings.fov);
    $('set-master').value = settings.masterVolume;
    $('val-master').textContent = volPct(settings.masterVolume);
    $('set-sfx').value = settings.sfxVolume;
    $('val-sfx').textContent = volPct(settings.sfxVolume);
    $('set-amb').value = settings.ambVolume;
    $('val-amb').textContent = volPct(settings.ambVolume);
    $('set-quality').value = settings.quality;
    $('set-perf').checked = !!settings.perfMode;
    $('set-daymode').checked = !!settings.dayMode;
    const mm = $('set-minimap'); if (mm) mm.checked = settings.minimapOn !== false;
    const mms = $('set-minimap-size'); if (mms) mms.value = settings.minimapSize || 'm';
    const mmo = $('set-minimap-opacity'); if (mmo) mmo.value = settings.minimapOpacity != null ? settings.minimapOpacity : 0.85;
    const mmov = $('val-minimap-opacity'); if (mmov) mmov.textContent = (settings.minimapOpacity != null ? settings.minimapOpacity : 0.85).toFixed(2);
    const mmr = $('set-minimap-rotate'); if (mmr) mmr.value = settings.minimapRotate || 'north';
    const vi = $('set-veh-invert'); if (vi) vi.checked = !!settings.vehSteerInvert;
    const vs = $('set-veh-sens'); if (vs) vs.value = settings.vehSteerSens != null ? settings.vehSteerSens : 1;
    const vsv = $('val-veh-sens'); if (vsv) vsv.textContent = (settings.vehSteerSens != null ? settings.vehSteerSens : 1).toFixed(2);
    const vc = $('set-veh-cam'); if (vc) vc.value = settings.vehCamDist != null ? settings.vehCamDist : 1;
    const vcv = $('val-veh-cam'); if (vcv) vcv.textContent = (settings.vehCamDist != null ? settings.vehCamDist : 1).toFixed(2);

    // Stage D — touch + accessibility controls
    const rng = (id, valId, key, dflt) => {
      const el = $(id); if (el) el.value = settings[key] != null ? settings[key] : dflt;
      const vv = $(valId); if (vv) vv.textContent = (settings[key] != null ? settings[key] : dflt).toFixed(2);
    };
    const chk = (id, key, dflt) => { const el = $(id); if (el) el.checked = settings[key] != null ? !!settings[key] : !!dflt; };
    const sel = (id, key, dflt) => { const el = $(id); if (el) el.value = settings[key] || dflt; };
    sel('set-touch-mode', 'touchControls', 'auto');
    const hand = $('set-handed-layout'); if (hand) hand.value = settings.leftHanded ? 'left' : 'right';
    chk('set-mobile-hud-compass', 'mobileHudCompass', true);
    chk('set-mobile-hud-objective', 'mobileHudObjective', true);
    chk('set-mobile-hud-vitals', 'mobileHudVitals', true);
    chk('set-mobile-hud-ammo', 'mobileHudAmmo', true);
    rng('set-look-sens', 'val-look-sens', 'lookSens', 1);
    rng('set-aim-sens', 'val-aim-sens', 'aimSens', 0.8);
    rng('set-joy-size', 'val-joy-size', 'joySize', 1);
    rng('set-look-stick-size', 'val-look-stick-size', 'lookStickSize', 1);
    rng('set-joy-opacity', 'val-joy-opacity', 'joyOpacity', 0.55);
    rng('set-btn-size', 'val-btn-size', 'btnSize', 1);
    rng('set-btn-opacity', 'val-btn-opacity', 'btnOpacity', 0.8);
    rng('set-hud-scale', 'val-hud-scale', 'hudScale', 1);
    rng('set-shake', 'val-shake', 'shakeScale', 1);
    sel('set-aim-mode', 'aimMode', 'hold');
    sel('set-aim-assist', 'aimAssist', 'low');
    // Master upgrade: ADS magnification, observation zoom, music
    const rngX = (id, valId, key, dflt, fmt) => {
      const el = $(id); const v = settings[key] != null ? settings[key] : dflt;
      if (el) el.value = v; const vv = $(valId); if (vv) vv.textContent = fmt(v);
    };
    rngX('set-ads-mag', 'val-ads-mag', 'adsMag', 1, v => v.toFixed(2) + '×');
    rngX('set-zoom-mag', 'val-zoom-mag', 'zoomMag', 2, v => v.toFixed(2) + '×');
    rngX('set-music-vol', 'val-music-vol', 'musicVolume', 0.45, volPct);
    sel('set-music-track', 'musicTrack', 'mortals');
    chk('set-music-on', 'musicEnabled', true);
    rngX('set-sfx', 'val-sfx', 'sfxVolume', 0.9, volPct);
    if (this.game && this.game._syncMusicButton) this.game._syncMusicButton();
    chk('set-invert-y', 'invertY', false);
    chk('set-auto-sprint', 'autoSprint', true);
    chk('set-auto-fire', 'autoFire', false);
    chk('set-vibration', 'vibration', true);
    chk('set-contrast', 'highContrast', false);
    chk('set-large-text', 'largeText', false);
    chk('set-reduce-motion', 'reduceMotion', false);
    chk('set-subtitles', 'subtitles', true);
    const mmsV = $('val-minimap-size'); if (mmsV) mmsV.textContent = (settings.minimapSize || 'm').toUpperCase();
    const mmrV = $('val-minimap-rotate'); if (mmrV) mmrV.textContent = (settings.minimapRotate || 'north').toUpperCase();
  }
}

void THREE;
