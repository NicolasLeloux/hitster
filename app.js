/* Hitster maison : scan d'une carte QR → lecture Spotify sans afficher la chanson.
 * La lecture passe par l'app Spotify du téléphone (Spotify Connect, compte Premium),
 * pilotée via l'API Web Spotify. Aucune information sur le morceau n'est affichée. */
(() => {
  "use strict";

  const SCOPES = "user-read-playback-state user-modify-playback-state";
  const API = "https://api.spotify.com/v1";
  const REDIRECT_URI = location.origin + location.pathname;
  const LS = {
    clientId: "hitster.clientId",
    token: "hitster.token",
    verifier: "hitster.verifier",
    state: "hitster.state",
    device: "hitster.deviceId",
  };

  const $ = (id) => document.getElementById(id);
  const screens = { login: $("screen-login"), main: $("screen-main"), scan: $("screen-scan") };

  // ---------- Utilitaires ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  function show(name) {
    for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  }

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  let msgTimer = null;
  function message(text, kind = "error", ms = 0) {
    const el = $("message");
    clearTimeout(msgTimer);
    if (!text) { el.hidden = true; return; }
    el.textContent = text;
    el.className = "message" + (kind === "info" ? " info" : "");
    el.hidden = false;
    if (ms) msgTimer = setTimeout(() => (el.hidden = true), ms);
  }

  function clientId() {
    return (window.HITSTER_CONFIG && window.HITSTER_CONFIG.spotifyClientId) || store.get(LS.clientId) || "";
  }

  // Accepte : spotify:track:ID, https://open.spotify.com/(intl-xx/)track/ID?..., ou ID nu (22 caractères base62)
  function parseTrackId(text) {
    if (!text) return null;
    const t = text.trim();
    let m = t.match(/^spotify:track:([A-Za-z0-9]{22})$/);
    if (m) return m[1];
    m = t.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/);
    if (m) return m[1];
    m = t.match(/^([A-Za-z0-9]{22})$/);
    if (m) return m[1];
    return null;
  }

  // ---------- Authentification Spotify (PKCE, sans serveur) ----------
  function randomString(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }

  async function sha256b64url(str) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function login() {
    const id = clientId() || $("client-id").value.trim();
    if (!id) { $("client-id").focus(); return; }
    store.set(LS.clientId, id);
    const verifier = randomString(64);
    const state = randomString(16);
    store.set(LS.verifier, verifier);
    store.set(LS.state, state);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: id,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      code_challenge_method: "S256",
      code_challenge: await sha256b64url(verifier),
      state,
    });
    location.assign("https://accounts.spotify.com/authorize?" + params);
  }

  function saveToken(data) {
    const prev = readToken() || {};
    const tok = {
      access: data.access_token,
      refresh: data.refresh_token || prev.refresh,
      expires: Date.now() + (data.expires_in - 60) * 1000,
    };
    store.set(LS.token, JSON.stringify(tok));
    return tok;
  }

  function readToken() {
    try { return JSON.parse(store.get(LS.token) || "null"); } catch { return null; }
  }

  async function tokenRequest(body) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    if (!res.ok) throw new Error("token " + res.status);
    return saveToken(await res.json());
  }

  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has("code") && !q.has("error")) return;
    history.replaceState(null, "", REDIRECT_URI);
    if (q.get("error")) throw new Error("Connexion refusée : " + q.get("error"));
    if (q.get("state") !== store.get(LS.state)) throw new Error("Réponse de connexion invalide, réessaie.");
    await tokenRequest({
      grant_type: "authorization_code",
      code: q.get("code"),
      redirect_uri: REDIRECT_URI,
      client_id: clientId(),
      code_verifier: store.get(LS.verifier),
    });
    store.del(LS.verifier);
    store.del(LS.state);
  }

  let refreshing = null;
  async function accessToken() {
    const tok = readToken();
    if (!tok) return null;
    if (Date.now() < tok.expires) return tok.access;
    if (!tok.refresh) return null;
    refreshing = refreshing || tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh, client_id: clientId() })
      .finally(() => (refreshing = null));
    try { return (await refreshing).access; } catch { return null; }
  }

  function logout() {
    store.del(LS.token);
    stopPolling();
    show("login");
    renderLogin();
  }

  // ---------- API Web Spotify ----------
  class ApiError extends Error {
    constructor(status, reason, msg) { super(msg || reason || String(status)); this.status = status; this.reason = reason; }
  }

  async function api(method, path, body, retry = true) {
    const token = await accessToken();
    if (!token) { logout(); throw new ApiError(401, "NO_TOKEN"); }
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      const tok = readToken();
      if (tok) { tok.expires = 0; store.set(LS.token, JSON.stringify(tok)); }
      return api(method, path, body, false);
    }
    if (res.status === 429 && retry) {
      const wait = Number(res.headers.get("Retry-After") || 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
      return api(method, path, body, false);
    }
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const err = data && data.error;
      throw new ApiError(res.status, err && err.reason, err && err.message);
    }
    return data;
  }

  // ---------- Appareils (Spotify Connect) ----------
  let deviceId = store.get(LS.device);

  async function listDevices() {
    const data = await api("GET", "/me/player/devices");
    return (data && data.devices) || [];
  }

  function pickDevice(devices) {
    return devices.find((d) => d.id === deviceId)
      || devices.find((d) => d.is_active)
      || devices.find((d) => d.type === "Smartphone")
      || devices[0] || null;
  }

  function setDevice(d) {
    deviceId = d ? d.id : null;
    if (deviceId) store.set(LS.device, deviceId); else store.del(LS.device);
    $("device-name").textContent = d ? d.name : "Aucun appareil";
  }

  async function ensureDevice() {
    const devices = await listDevices();
    const d = pickDevice(devices);
    setDevice(d);
    return d;
  }

  async function openDeviceDialog() {
    const dlg = $("dlg-devices");
    if (!dlg.open) dlg.showModal();
    const ul = $("device-list");
    ul.innerHTML = "<li class='muted small'>Recherche…</li>";
    try {
      const devices = await listDevices();
      ul.innerHTML = "";
      if (!devices.length) ul.innerHTML = "<li class='muted small'>Aucun appareil trouvé. Ouvre Spotify puis actualise.</li>";
      for (const d of devices) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.className = "btn" + (d.id === deviceId ? " active" : "");
        b.textContent = `${d.type === "Smartphone" ? "📱" : d.type === "Computer" ? "💻" : "🔊"} ${d.name}`;
        b.onclick = () => { setDevice(d); dlg.close(); };
        li.appendChild(b);
        ul.appendChild(li);
      }
    } catch (e) {
      ul.innerHTML = "";
      message(explain(e));
    }
  }

  // ---------- Lecture ----------
  const state = { loaded: false, playing: false, pos: 0, dur: 0, at: 0, dragging: false, trackId: null };

  function explain(e) {
    if (e.status === 403) return "Spotify refuse la commande : un compte Premium est nécessaire (ou ce compte n'est pas autorisé dans l'app Spotify Developer).";
    if (e.status === 404 || e.reason === "NO_ACTIVE_DEVICE") return "Aucun appareil Spotify actif. Ouvre l'app Spotify sur ce téléphone, puis réessaie.";
    if (e.status === 401) return "Session Spotify expirée, reconnecte-toi.";
    return "Erreur Spotify : " + (e.message || e);
  }

  async function playTrack(id) {
    message("");
    state.trackId = id;
    $("hint").textContent = "Lancement…";
    let d = await ensureDevice().catch(() => null);
    if (!d) {
      message("Aucun appareil Spotify trouvé. Ouvre l'app Spotify (bouton en haut à droite), reviens ici, puis rescanne la carte.");
      $("hint").textContent = "Scanne une carte pour lancer la musique.";
      openDeviceDialog();
      return;
    }
    const body = { uris: ["spotify:track:" + id], position_ms: 0 };
    try {
      await api("PUT", "/me/player/play?device_id=" + encodeURIComponent(d.id), body);
    } catch (e) {
      if (e.status === 404) {
        // L'appareil mémorisé a disparu : on en cherche un autre une fois.
        setDevice(null);
        d = await ensureDevice().catch(() => null);
        if (!d) { message(explain(e)); return; }
        try { await api("PUT", "/me/player/play?device_id=" + encodeURIComponent(d.id), body); }
        catch (e2) { message(explain(e2)); return; }
      } else { message(explain(e)); return; }
    }
    // Répéter le morceau : évite que Spotify enchaîne sur une autre chanson à la fin.
    api("PUT", "/me/player/repeat?state=track&device_id=" + encodeURIComponent(d.id)).catch(() => {});
    state.loaded = true;
    state.playing = true;
    state.pos = 0;
    state.dur = 0;
    state.at = performance.now();
    $("player").hidden = false;
    $("hint").textContent = "Écoute… À toi de deviner l'année !";
    render();
    startPolling();
    setTimeout(poll, 700);
  }

  async function togglePlay() {
    if (!state.loaded) return;
    const was = state.playing;
    state.pos = currentPos();
    state.playing = !was;
    state.at = performance.now();
    render();
    try {
      if (was) await api("PUT", "/me/player/pause" + devQ());
      else await api("PUT", "/me/player/play" + devQ());
    } catch (e) {
      state.playing = was;
      render();
      message(explain(e), "error", 6000);
    }
  }

  async function seekTo(ms) {
    if (!state.loaded) return;
    ms = Math.max(0, Math.min(ms, state.dur || ms));
    state.pos = ms;
    state.at = performance.now();
    render();
    try { await api("PUT", "/me/player/seek?position_ms=" + Math.round(ms) + devQ("&")); }
    catch (e) { message(explain(e), "error", 6000); }
  }

  function devQ(sep = "?") { return deviceId ? sep + "device_id=" + encodeURIComponent(deviceId) : ""; }

  function currentPos() {
    if (!state.playing) return state.pos;
    const p = state.pos + (performance.now() - state.at);
    return state.dur ? Math.min(p, state.dur) : p;
  }

  // Synchronisation avec l'état réel du lecteur (sans jamais afficher le titre).
  let pollTimer = null, rafId = null;
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(poll, 2500);
    const loop = () => { render(); rafId = requestAnimationFrame(loop); };
    rafId = requestAnimationFrame(loop);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    cancelAnimationFrame(rafId);
    pollTimer = rafId = null;
  }

  async function poll() {
    if (document.hidden || !state.loaded) return;
    try {
      const p = await api("GET", "/me/player");
      if (!p || !p.item) return;
      state.dur = p.item.duration_ms;
      if (!state.dragging) {
        state.pos = p.progress_ms || 0;
        state.at = performance.now();
      }
      state.playing = !!p.is_playing;
      if (p.device) setDevice(p.device);
    } catch { /* silencieux : on réessaie au prochain tour */ }
  }

  function render() {
    const pos = state.dragging ? Number($("seek").value) / 1000 * state.dur : currentPos();
    $("t-cur").textContent = fmt(pos);
    $("t-dur").textContent = state.dur ? fmt(state.dur) : "–:––";
    if (!state.dragging) $("seek").value = state.dur ? Math.round((pos / state.dur) * 1000) : 0;
    $("btn-play").textContent = state.playing ? "❚❚" : "▶";
    $("disc").classList.toggle("spinning", state.playing);
  }

  // ---------- Scanner QR ----------
  let stream = null, scanning = false, detector = null;

  async function startScan() {
    message("");
    show("scan");
    const video = $("video");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      show("main");
      message("Impossible d'accéder à la caméra. Autorise la caméra pour cette app dans les réglages du téléphone.");
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!detector && "BarcodeDetector" in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code")) detector = new BarcodeDetector({ formats: ["qr_code"] });
      } catch {}
    }
    scanning = true;
    scanLoop();
  }

  function stopScan() {
    scanning = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    $("video").srcObject = null;
  }

  async function scanLoop() {
    const video = $("video"), canvas = $("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let lastInvalid = 0;
    while (scanning) {
      await new Promise((r) => setTimeout(r, 120));
      if (!scanning || video.readyState < 2) continue;
      let text = null;
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes.length) text = codes[0].rawValue;
        } else {
          const w = video.videoWidth, h = video.videoHeight;
          if (!w || !h) continue;
          const scale = Math.min(1, 640 / Math.max(w, h));
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code) text = code.data;
        }
      } catch { continue; }
      if (!text) continue;
      const id = parseTrackId(text);
      if (id) {
        if (navigator.vibrate) navigator.vibrate(60);
        stopScan();
        show("main");
        playTrack(id);
        return;
      }
      if (Date.now() - lastInvalid > 2500) {
        lastInvalid = Date.now();
        document.querySelector(".scan-hint").textContent = "Ce QR code n'est pas une carte Hitster";
        setTimeout(() => (document.querySelector(".scan-hint").textContent = "Vise le QR code de la carte"), 2000);
      }
    }
  }

  // ---------- Démarrage ----------
  function renderLogin() {
    $("redirect-uri").textContent = REDIRECT_URI;
    $("client-id-field").hidden = !!(window.HITSTER_CONFIG && window.HITSTER_CONFIG.spotifyClientId);
    $("client-id").value = store.get(LS.clientId) || "";
  }

  function bind() {
    $("btn-login").onclick = login;
    $("btn-logout").onclick = logout;
    $("btn-scan").onclick = startScan;
    $("btn-cancel-scan").onclick = () => { stopScan(); show("main"); };
    $("btn-play").onclick = togglePlay;
    $("btn-back").onclick = () => seekTo(currentPos() - 10000);
    $("btn-fwd").onclick = () => seekTo(currentPos() + 10000);
    $("btn-device").onclick = openDeviceDialog;
    $("btn-refresh-devices").onclick = openDeviceDialog;
    $("btn-close-devices").onclick = () => $("dlg-devices").close();
    const seek = $("seek");
    seek.addEventListener("input", () => { state.dragging = true; render(); });
    seek.addEventListener("change", () => {
      state.dragging = false;
      seekTo(Number(seek.value) / 1000 * state.dur);
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  }

  async function init() {
    bind();
    renderLogin();
    try { await handleRedirect(); }
    catch (e) { show("login"); alert(e.message); return; }
    if (!readToken()) { show("login"); return; }
    show("main");
    ensureDevice().catch((e) => { if (e.status !== 401) message(explain(e), "info"); });
  }

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Exposé pour les tests.
  window.__hitster = { parseTrackId };
  init();
})();
