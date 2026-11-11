/**
 * PWA registration, offline status and player-controlled, mission-safe updates.
 * The service worker only activates a new release after its atomic precache has
 * completed. A reload requested during play is deferred until a safe screen.
 */
(function () {
  'use strict';
  const state = window.OBV_PWA = {
    supported: 'serviceWorker' in navigator,
    registered: false,
    updateAvailable: false,
    updatePendingSafePoint: false,
    error: null,
    registration: null,
    version: null,
  };
  if (!state.supported) return;
  if (!window.isSecureContext) { state.error = 'insecure-context'; return; }

  let banner = null;
  let status = null;
  let activateWhenSafe = null;
  let reloading = false;
  const hadControllerAtLaunch = !!navigator.serviceWorker.controller;

  function isSafeReloadPoint() {
    const gameState = window.OBV && window.OBV.state;
    return !['playing', 'paused', 'loading'].includes(gameState);
  }

  function showStatus() {
    if (!status) {
      status = document.createElement('div');
      status.id = 'pwa-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      Object.assign(status.style, {
        position: 'fixed', right: '12px', top: 'max(10px, env(safe-area-inset-top))', zIndex: '499',
        padding: '6px 9px', borderRadius: '4px',
        background: 'rgba(7,9,11,.84)', border: '1px solid rgba(150,160,170,.25)',
        color: '#aeb7bf', font: '600 10px/1.2 ui-monospace, Menlo, Consolas, monospace',
        letterSpacing: '.04em', pointerEvents: 'none',
      });
      document.body.appendChild(status);
    }
    const online = navigator.onLine;
    if (!online) {
      status.textContent = 'OFFLINE · INSTALLED GAME READY';
      status.style.display = 'block';
    } else if (state.error && state.error !== 'insecure-context') {
      status.textContent = 'UPDATE CHECK FAILED · CURRENT BUILD SAFE';
      status.style.display = 'block';
    } else if (state.updateAvailable) {
      status.textContent = 'UPDATE READY';
      status.style.display = 'block';
    } else {
      status.style.display = 'none';
    }
  }

  function button(label, id) {
    const el = document.createElement('button');
    el.type = 'button'; el.id = id; el.textContent = label;
    Object.assign(el.style, {
      appearance: 'none', border: '1px solid #d9a441', background: 'transparent',
      color: '#d9a441', padding: '5px 10px', borderRadius: '4px',
      font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
    });
    return el;
  }

  function showUpdateBanner() {
    if (banner || !document.body) return;
    banner = document.createElement('div');
    banner.id = 'pwa-update-banner';
    banner.setAttribute('role', 'status');
    Object.assign(banner.style, {
      position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
      zIndex: '500', display: 'flex', alignItems: 'center', gap: '10px',
      padding: '10px 14px', borderRadius: '6px',
      background: 'rgba(7,9,11,0.96)', border: '1px solid rgba(217,164,65,0.55)',
      color: '#d9a441', font: '600 12px/1.2 ui-monospace, Menlo, Consolas, monospace',
      letterSpacing: '0.04em', boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
      maxWidth: 'calc(100vw - 24px)',
    });
    const message = document.createElement('span');
    message.textContent = state.updatePendingSafePoint ? 'UPDATE READY · WAITING FOR SAFE POINT' : 'VEILSTRIKE UPDATE READY';
    message.id = 'pwa-update-message';
    const reloadButton = button(state.updatePendingSafePoint ? 'AFTER MISSION' : 'RELOAD', 'pwa-update-reload');
    const laterButton = button('LATER', 'pwa-update-later');
    laterButton.style.borderColor = '#4a525a'; laterButton.style.color = '#8a949e';
    banner.append(message, reloadButton, laterButton);
    document.body.appendChild(banner);
    reloadButton.addEventListener('click', requestSafeActivation);
    laterButton.addEventListener('click', () => { banner.remove(); banner = null; });
  }

  function requestSafeActivation() {
    const reg = state.registration;
    const worker = reg && reg.waiting;
    // Another open VEILSTRIKE tab may already have activated this update. In
    // that case there is no waiting worker to message; reload only on consent
    // and only once this page reaches a safe screen.
    if (!worker) {
      if (!state.updateAvailable || !navigator.serviceWorker.controller) return;
      if (!isSafeReloadPoint()) {
        state.updatePendingSafePoint = true;
        showUpdateBanner();
        const msg = banner && banner.querySelector('#pwa-update-message');
        const btn = banner && banner.querySelector('#pwa-update-reload');
        if (msg) msg.textContent = 'UPDATE READY · WAITING FOR SAFE POINT';
        if (btn) btn.textContent = 'AFTER MISSION';
        return;
      }
      if (!reloading) { reloading = true; window.location.reload(); }
      return;
    }
    if (!isSafeReloadPoint()) {
      state.updatePendingSafePoint = true;
      const msg = banner && banner.querySelector('#pwa-update-message');
      const btn = banner && banner.querySelector('#pwa-update-reload');
      if (msg) msg.textContent = 'UPDATE READY · WAITING FOR SAFE POINT';
      if (btn) btn.textContent = 'AFTER MISSION';
      showStatus();
      return;
    }
    if (reloading) return;
    reloading = true;
    activateWhenSafe = worker;
    worker.postMessage({ type: 'SKIP_WAITING' });
    // A controller change confirms activation; safety-net timeout only clears
    // the lock. It deliberately never reloads an unconfirmed update.
    setTimeout(() => { if (!navigator.serviceWorker.controller) reloading = false; }, 8000);
  }

  function maybeActivateAtSafePoint() {
    if (state.updatePendingSafePoint && isSafeReloadPoint()) requestSafeActivation();
  }

  function checkForUpdate() {
    if (!navigator.onLine || !state.registration) { showStatus(); return; }
    state.registration.update().catch((error) => {
      // An update-network error is non-fatal; the active cache remains the
      // installed playable version and online status is not shown as broken.
      state.lastUpdateError = String(error && error.message || error);
      showStatus();
    });
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SW_VERSION') state.version = event.data.version;
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading || !activateWhenSafe || reloaded) {
      // A different open tab may have accepted the update. Notify this tab but
      // never reload it automatically; it may currently be in a mission.
      if (hadControllerAtLaunch && state.registered) {
        state.updateAvailable = true;
        showUpdateBanner();
        showStatus();
      }
      return;
    }
    if (!isSafeReloadPoint()) {
      state.updatePendingSafePoint = true;
      reloading = false;
      activateWhenSafe = null;
      showUpdateBanner();
      return;
    }
    reloaded = true;
    window.location.reload();
  });
  let reloaded = false;

  navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    state.registered = true;
    state.registration = reg;
    if (reg.active) reg.active.postMessage({ type: 'GET_VERSION' });
    if (reg.waiting && navigator.serviceWorker.controller) {
      state.updateAvailable = true;
      showUpdateBanner();
    }
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          state.updateAvailable = true;
          showUpdateBanner();
          showStatus();
        } else if (installing.state === 'redundant') {
          state.error = 'update-install-failed';
          showStatus();
        }
      });
    });
    checkForUpdate();
    setInterval(checkForUpdate, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
    // Game state may change without a DOM event; only a pending player request
    // is acted on, and only at a safe non-mission screen.
    setInterval(maybeActivateAtSafePoint, 1000);
    showStatus();
  }).catch((error) => {
    state.error = String(error && error.message || error);
    showStatus();
    console.warn('[pwa] service worker registration failed:', error);
  });

  window.addEventListener('online', () => { state.error = null; showStatus(); checkForUpdate(); });
  window.addEventListener('offline', showStatus);
})();
