/* ---------- PWA ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js'));
}

/* ---------- Helpers y estado ---------- */
const $ = (sel) => document.querySelector(sel);
const units = {
  celsius: { temp: "°C", wind: "km/h" },
  fahrenheit: { temp: "°F", wind: "mph" }
};

const THEME_KEY = 'theme'; // 'light' | 'dark'
let themeState = { theme: null, mapLayers: { light: null, dark: null } };

let state = {
  unit: "celsius",
  lastWeather: null,
  suggestions: [],
  highlightIndex: -1,
  cities: loadCities(),
  charts: { temp: null, rain: null, wind: null, cloud: null },
  map: null,
  mapMarker: null
};

const form = $("#searchForm");
const queryInput = $("#query");
const choicesBox = $("#choices");
const unitToggle = $("#unitToggle");
const spinner = $("#spinner");
const geoBtn = $("#geoBtn");
const citySelect = $("#citySelect");
const addCityBtn = $("#addCityBtn");
const removeCityBtn = $("#removeCityBtn");

/* ---------- Init ---------- */
initTheme();
renderCityList();
restoreLastWeatherIfOffline();
initMap();

/* ---------- Eventos UI ---------- */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = queryInput.value.trim();
  if (!q) return;
  if (state.highlightIndex >= 0 && state.suggestions[state.highlightIndex]) {
    const s = state.suggestions[state.highlightIndex];
    return fetchWeather({ latitude: s.latitude, longitude: s.longitude, label: placeLabel(s) });
  }
  await searchPlace(q);
});

unitToggle.addEventListener("change", () => {
  state.unit = unitToggle.checked ? "fahrenheit" : "celsius";
  renderWeather(state.lastWeather);
  if (state.lastWeather) renderHourlyCharts(state.lastWeather);
});

geoBtn.addEventListener("click", () => {
  if (!navigator.geolocation) return alert("Tu navegador no soporta geolocalización.");
  setLoading(true);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    const label = await nameFromCoords(latitude, longitude);
    await fetchWeather({ latitude, longitude, label });
    setLoading(false);
  }, (err) => {
    setLoading(false);
    alert("No se pudo obtener tu ubicación.");
    console.error(err);
  }, { enableHighAccuracy: true, timeout: 10000 });
});

citySelect.addEventListener("change", async () => {
  const idx = citySelect.selectedIndex;
  if (idx < 0) return;
  const c = state.cities[idx];
  await fetchWeather(c);
});

addCityBtn.addEventListener("click", () => {
  if (!state.lastWeather) return alert("Primero busca una ciudad.");
  const { label, latitude, longitude } = state.lastWeather._meta;
  const exists = state.cities.some(c => c.label === label);
  if (exists) return toast("Ya está en la lista.");
  state.cities.push({ label, latitude, longitude });
  saveCities(state.cities);
  renderCityList(label);
  toast("Ciudad añadida");
});

removeCityBtn.addEventListener("click", () => {
  const idx = citySelect.selectedIndex;
  if (idx < 0) return;
  const removed = state.cities.splice(idx, 1);
  saveCities(state.cities);
  renderCityList();
  toast(`Eliminada: ${removed[0].label}`);
});

/* ---------- Autocompletado ---------- */
let debounceTimer = null;
queryInput.addEventListener("input", () => {
  const q = queryInput.value.trim();
  if (!q) { hideChoices(); return; }
  showSpinner(true);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => liveSuggest(q), 350);
});
queryInput.addEventListener("keydown", (e) => {
  if (!choicesBox.classList.contains("show")) return;
  const max = state.suggestions.length - 1;
  if (e.key === "ArrowDown") {
    e.preventDefault(); state.highlightIndex = Math.min(max, state.highlightIndex + 1); renderChoices();
  } else if (e.key === "ArrowUp") {
    e.preventDefault(); state.highlightIndex = Math.max(0, state.highlightIndex - 1); renderChoices();
  } else if (e.key === "Enter" && state.highlightIndex >= 0) {
    e.preventDefault();
    const s = state.suggestions[state.highlightIndex];
    hideChoices();
    fetchWeather({ latitude: s.latitude, longitude: s.longitude, label: placeLabel(s) });
  } else if (e.key === "Escape") hideChoices();
});
async function liveSuggest(name){
  try{
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=es&format=json`, { cache:'no-store' });
    const data = await res.json();
    state.suggestions = data.results || [];
    state.highlightIndex = state.suggestions.length ? 0 : -1;
    renderChoices();
  }catch(e){
    console.error(e); state.suggestions = []; hideChoices();
  }finally{ showSpinner(false); }
}
function renderChoices(){
  if (!state.suggestions.length) return hideChoices();
  choicesBox.innerHTML = state.suggestions.map((r, i) => `
    <div class="choice" role="option" aria-selected="${i===state.highlightIndex}" tabindex="-1"
      data-lat="${r.latitude}" data-lon="${r.longitude}">
      <span>${placeLabel(r)}</span>
      <span class="badge">${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}</span>
    </div>
  `).join("");
  choicesBox.classList.add("show"); $(".search-wrap").setAttribute("aria-expanded", "true");
  choicesBox.querySelectorAll(".choice").forEach((el, i) => {
    el.addEventListener("mouseenter", () => { state.highlightIndex = i; renderChoices(); });
    el.addEventListener("click", () => {
      const lat = parseFloat(el.dataset.lat);
      const lon = parseFloat(el.dataset.lon);
      hideChoices();
      fetchWeather({ latitude: lat, longitude: lon, label: el.querySelector("span").textContent });
    });
  });
}
function hideChoices(){ choicesBox.classList.remove("show"); $(".search-wrap").setAttribute("aria-expanded", "false"); choicesBox.innerHTML=""; state.suggestions=[]; state.highlightIndex=-1; }

/* ---------- Búsqueda clásica ---------- */
async function searchPlace(name){
  setLoading(true); hideChoices();
  try{
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=es&format=json`;
    const res = await fetch(url, { cache:'no-store' });
    if(!res.ok) throw new Error("Error de geocodificación");
    const data = await res.json();
    if(!data.results || data.results.length === 0){
      choicesBox.innerHTML = `<div class="choice">No se encontraron lugares.</div>`;
      choicesBox.classList.add("show"); return;
    }
    if(data.results.length > 1){
      state.suggestions = data.results; state.highlightIndex = 0; renderChoices(); return;
    }
    const r = data.results[0];
    await fetchWeather({ latitude: r.latitude, longitude: r.longitude, label: placeLabel(r) });
  }catch(err){ console.error(err); alert("Hubo un problema buscando el lugar."); }
  finally{ setLoading(false); }
}

/* ---------- Datos + mapa ---------- */
async function fetchWeather({ latitude, longitude, label }){
  setLoading(true); hideChoices();
  try{
    const params = new URLSearchParams({
      latitude, longitude,
      current: [
        "temperature_2m","relative_humidity_2m","apparent_temperature","is_day",
        "pressure_msl","wind_speed_10m","wind_direction_10m",
        "cloudcover","uv_index","precipitation","visibility"
      ].join(","),
      daily: [
        "weathercode","temperature_2m_max","temperature_2m_min","sunrise","sunset",
        "precipitation_probability_max","precipitation_sum","uv_index_max","sunshine_duration","precipitation_hours","snowfall_sum"
      ].join(","),
      hourly: [
        "temperature_2m","precipitation_probability","wind_speed_10m","wind_direction_10m","cloudcover","apparent_temperature"
      ].join(","),
      timezone: "auto", forecast_days: "7", forecast_hours: "48"
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, { cache:'no-store' });
    if(!res.ok) throw new Error("Error al obtener el tiempo");
    const data = await res.json();
    data._meta = { label, latitude, longitude, fetchedAt: new Date().toISOString() };
    state.lastWeather = data;
    try { localStorage.setItem('lastWeather', JSON.stringify(data)); } catch {}

    // Mapa
    if (state.map && state.mapMarker) {
      state.map.setView([latitude, longitude], 10);
      state.mapMarker.setLatLng([latitude, longitude]).bindPopup(label).openPopup();
    }

    renderWeather(data);
    renderHourlyCharts(data);
  }catch(err){ console.error(err); alert("No se pudo obtener el tiempo."); }
  finally{ setLoading(false); }
}

function renderWeather(data){
  if(!data) return;
  $("#results").classList.remove("hidden");
  $("#placeName").textContent = data._meta.label;
  $("#coords").textContent = `${Number(data._meta.latitude).toFixed(2)}, ${Number(data._meta.longitude).toFixed(2)}`;

  const u = state.unit;
  const t = convertTemp(data.current.temperature_2m, u);
  const feels = convertTemp(data.current.apparent_temperature, u);
  const wind = convertWind(data.current.wind_speed_10m, u);
  const wcode = data.daily.weathercode?.[0];

  const uvNow = data.current.uv_index ?? null;
  const cloudsNow = data.current.cloudcover ?? null;
  const visNowKm = data.current.visibility != null ? (data.current.visibility / 1000) : null;
  const precipTodayMm = data.daily.precipitation_sum?.[0] ?? null;
  const sunshineSec = data.daily.sunshine_duration?.[0] ?? null;
  const sunshineHours = sunshineSec != null ? (sunshineSec / 3600) : null;

  $("#currentTemp").textContent = `${Math.round(t)}${units[u].temp}`;
  $("#currentSummary").textContent = `${weatherCodeToText(wcode)} · Sensación ${Math.round(feels)}${units[u].temp}`;
  $("#wind").textContent = `${round1(wind)} ${units[u].wind} (${Math.round(data.current.wind_direction_10m)}°)`;
  $("#humidity").textContent = `${Math.round(data.current.relative_humidity_2m)}%`;
  $("#pressure").textContent = `${Math.round(data.current.pressure_msl)} hPa`;
  $("#sunrise").textContent = timeLocal(data.daily.sunrise[0]);
  $("#sunset").textContent = timeLocal(data.daily.sunset[0]);
  $("#updated").textContent = dateTimeLocal(data._meta.fetchedAt);

  $("#uv").textContent = uvNow != null ? uvNow.toFixed(1) : "—";
  $("#clouds").textContent = cloudsNow != null ? `${Math.round(cloudsNow)}%` : "—";
  $("#visibility").textContent = visNowKm != null ? `${round1(visNowKm)} km` : "—";
  $("#precipSum").textContent = precipTodayMm != null ? `${round1(precipTodayMm)} mm` : "—";
  $("#sunHours").textContent = sunshineHours != null ? `${round1(sunshineHours)} h` : "—";

  // 7 días
  const days = data.daily.time;
  const max = data.daily.temperature_2m_max;
  const min = data.daily.temperature_2m_min;
  const wcodes = data.daily.weathercode;
  const pprob = data.daily.precipitation_probability_max;

  $("#daily").innerHTML = days.map((d, i) => `
    <article class="card" aria-label="Pronóstico para ${dateLocal(d)}">
      <h4>${weekdayShort(d)} ${dateLocal(d)}</h4>
      <div class="temp-row">
        <span>Max: <strong>${Math.round(convertTemp(max[i], u))}${units[u].temp}</strong></span>
        <span>Min: <strong>${Math.round(convertTemp(min[i], u))}${units[u].temp}</strong></span>
      </div>
      <div class="badge">${weatherCodeToText(wcodes[i])}</div>
      <div class="badge">Lluvia: ${pprob?.[i] == null ? "—" : pprob[i] + "%"}</div>
      <div class="badge">Acum.: ${data.daily.precipitation_sum?.[i] == null ? "—" : round1(data.daily.precipitation_sum[i]) + " mm"}</div>
      <div class="badge">UV máx: ${data.daily.uv_index_max?.[i] == null ? "—" : round1(data.daily.uv_index_max[i])}</div>
      ${data.daily.sunshine_duration?.[i] != null ? `<div class="badge">Sol: ${round1(data.daily.sunshine_duration[i]/3600)} h</div>` : ""}
    </article>
  `).join("");
}

/* ---------- Gráficas ---------- */
function renderHourlyCharts(data){
  if (!data?.hourly) return;

  const now = Date.now();
  const labels = [];
  const temps = [];
  const rains = [];
  const winds = [];
  const windDirs = [];
  const clouds = [];

  for (let i = 0; i < data.hourly.time.length; i++){
    const ts = new Date(data.hourly.time[i]).getTime();
    if (ts >= now && labels.length < 48){
      labels.push(hourShort(data.hourly.time[i]));
      temps.push(convertTemp(data.hourly.temperature_2m[i], state.unit));
      rains.push(data.hourly.precipitation_probability?.[i] ?? null);
      winds.push(data.hourly.wind_speed_10m?.[i] ?? null);
      windDirs.push(data.hourly.wind_direction_10m?.[i] ?? null);
      clouds.push(data.hourly.cloudcover?.[i] ?? null);
    }
  }

  if (state.charts.temp) state.charts.temp.destroy();
  if (state.charts.rain) state.charts.rain.destroy();
  if (state.charts.wind) state.charts.wind.destroy();
  if (state.charts.cloud) state.charts.cloud.destroy();

  const tempCtx = document.getElementById('hourlyTempChart').getContext('2d');
  const rainCtx = document.getElementById('hourlyRainChart').getContext('2d');
  const windCtx = document.getElementById('hourlyWindChart').getContext('2d');
  const cloudCtx = document.getElementById('hourlyCloudChart').getContext('2d');

  // Ajuste de colores por tema
  Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--chart-text').trim();
  Chart.defaults.borderColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim();

  state.charts.temp = new Chart(tempCtx, {
    type: 'line',
    data: { labels, datasets: [{ label: `Temperatura (${units[state.unit].temp})`, data: temps, tension: 0.25, pointRadius: 0 }] },
    options: { responsive:true, maintainAspectRatio:false, scales:{ x:{ ticks:{autoSkip:true,maxTicksLimit:12}}, y:{beginAtZero:false}}, plugins:{ legend:{display:true}, tooltip:{mode:'index', intersect:false} } }
  });

  state.charts.rain = new Chart(rainCtx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Probabilidad de lluvia (%)', data: rains, borderWidth: 1 }] },
    options: { responsive:true, maintainAspectRatio:false, scales:{ x:{ ticks:{autoSkip:true,maxTicksLimit:12}}, y:{ suggestedMin:0, suggestedMax:100, ticks:{ callback:v=>v+'%' } } }, plugins:{ legend:{display:true}, tooltip:{ callbacks:{ label:ctx=>`${ctx.parsed.y ?? 0}%` } } } }
  });

  const windUnits = state.unit === 'fahrenheit' ? 'mph' : 'km/h';
  const windData = state.unit === 'fahrenheit' ? winds.map(v => v != null ? v * 0.621371 : null) : winds;

  state.charts.wind = new Chart(windCtx, {
    type: 'line',
    data: { labels, datasets: [{ label:`Viento (${windUnits})`, data: windData, tension:0.25, pointRadius:3, pointStyle:'triangle',
      rotation:(ctx)=>{ const i=ctx.dataIndex; const deg=windDirs[i] ?? 0; return (deg*Math.PI/180); } }] },
    options: { responsive:true, maintainAspectRatio:false, scales:{ x:{ ticks:{autoSkip:true,maxTicksLimit:12}}, y:{beginAtZero:true}}, plugins:{ legend:{display:true}, tooltip:{ callbacks:{ label:(ctx)=>{ const speed=ctx.parsed.y!=null?ctx.parsed.y.toFixed(0):'0'; const dir=windDirs[ctx.dataIndex]??0; return `${speed} ${windUnits} · ${dir}°`; } } } } }
  });

  state.charts.cloud = new Chart(cloudCtx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Nubosidad (%)', data: clouds, tension: 0.25, pointRadius: 0 }] },
    options: { responsive:true, maintainAspectRatio:false, scales:{ x:{ ticks:{autoSkip:true,maxTicksLimit:12}}, y:{ suggestedMin:0, suggestedMax:100, ticks:{ callback:v=>v+'%' } } }, plugins:{ legend:{display:true}, tooltip:{ callbacks:{ label:ctx=>`${ctx.parsed.y ?? 0}%` } } } }
  });
}

/* ---------- Mapa ---------- */
function initMap(){
  state.map = L.map('map', { zoomControl: true, attributionControl: true }).setView([0,0], 2);
  const attr = '&copy; OpenStreetMap contributors &copy; CARTO';
  themeState.mapLayers.light = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom:20, attribution: attr });
  themeState.mapLayers.dark  = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',  { maxZoom:20, attribution: attr });
  const current = themeState.theme === 'dark' ? themeState.mapLayers.dark : themeState.mapLayers.light;
  current.addTo(state.map);
  state.mapMarker = L.marker([0,0]).addTo(state.map);
}
function switchMapBasemap(mode){
  const map = state.map; if (!map) return;
  const { light, dark } = themeState.mapLayers;
  const target = mode === 'dark' ? dark : light; const other = mode === 'dark' ? light : dark;
  if (other && map.hasLayer(other)) map.removeLayer(other);
  if (target && !map.hasLayer(target)) target.addTo(map);
}

/* ---------- Tema ---------- */
function initTheme(){
  const saved = localStorage.getItem(THEME_KEY);
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (systemPrefersDark ? 'dark' : 'light');
  setTheme(theme);
  if (!saved && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => setTheme(e.matches ? 'dark' : 'light', {remember:false}));
  }
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', () => setTheme(themeState.theme === 'dark' ? 'light' : 'dark'));
}
function setTheme(mode, opts={remember:true}){
  themeState.theme = mode;
  document.documentElement.setAttribute('data-theme', mode);
  if (opts.remember) localStorage.setItem(THEME_KEY, mode);
  if (state?.map) switchMapBasemap(mode);
  if (window.Chart && state?.lastWeather) renderHourlyCharts(state.lastWeather);
}

/* ---------- Utils ---------- */
function placeLabel(r){ return [r.name, r.admin1, r.country].filter(Boolean).join(", "); }
function loadCities(){ try { return JSON.parse(localStorage.getItem('cities') || '[]'); } catch { return []; } }
function saveCities(arr){ try { localStorage.setItem('cities', JSON.stringify(arr)); } catch {} }
function renderCityList(selectLabel){ const el=$("#citySelect"); el.innerHTML = state.cities.map(c => `<option>${c.label}</option>`).join(""); if (selectLabel){ const idx=state.cities.findIndex(c=>c.label===selectLabel); el.selectedIndex=idx; } }
function round1(x){ return Math.round(x*10)/10; }
function convertTemp(valC, unit){ return unit === "fahrenheit" ? (valC * 9/5 + 32) : valC; }
function convertWind(kmh, unit){ return unit === "fahrenheit" ? (kmh * 0.621371) : kmh; }
function timeLocal(iso){ const d=new Date(iso); return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }); }
function dateLocal(iso){ const d=new Date(iso); return d.toLocaleDateString([], { day:"2-digit", month:"2-digit" }); }
function dateTimeLocal(iso){ const d=new Date(iso); return d.toLocaleString([], { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }); }
function weekdayShort(iso){ const d=new Date(iso); return d.toLocaleDateString("es-ES", { weekday:"short" }).replace(".", ""); }
function hourShort(iso){ const d=new Date(iso); return d.toLocaleTimeString([], { hour:"2-digit" }); }
function setLoading(isLoading){ const btn=form.querySelector("button[type='submit']"); btn.disabled=isLoading; btn.textContent=isLoading?"Buscando...":"Buscar"; }
function showSpinner(v){ spinner.classList.toggle("show", v); }
function weatherCodeToText(code){
  const map = { 0:"Despejado",1:"Principalmente despejado",2:"Parcialmente nublado",3:"Nublado",45:"Niebla",48:"Niebla con escarcha",
    51:"Llovizna ligera",53:"Llovizna",55:"Llovizna intensa",56:"Llovizna helada ligera",57:"Llovizna helada intensa",
    61:"Lluvia ligera",63:"Lluvia",65:"Lluvia intensa",66:"Lluvia helada ligera",67:"Lluvia helada intensa",
    71:"Nieve ligera",73:"Nieve",75:"Nieve intensa",77:"Granos de nieve",80:"Chubascos ligeros",81:"Chubascos",82:"Chubascos fuertes",
    85:"Chubascos de nieve ligeros",86:"Chubascos de nieve fuertes",95:"Tormenta",96:"Tormenta con granizo ligero",99:"Tormenta con granizo fuerte" };
  return map[code] ?? "—";
}

/* ---------- Reverse geocoding (solo BigDataCloud, CORS-friendly) ---------- */
async function nameFromCoords(lat, lon){
  try{
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=es`;
    const res = await fetch(url, { cache:'no-store' });
    if (res.ok) {
      const j = await res.json();
      const parts = [j.city || j.locality, j.principalSubdivision, j.countryName].filter(Boolean);
      if (parts.length) return parts.join(", ");
    }
  }catch(e){
    console.warn("Reverse geocoding falló:", e);
  }
  return `Mi ubicación (${lat.toFixed(2)}, ${lon.toFixed(2)})`;
}

/* ---------- Offline de cortes: restaurar último pronóstico + geo auto ---------- */
function restoreLastWeatherIfOffline(){
  window.addEventListener('load', async () => {
    if (!navigator.onLine && localStorage.getItem('lastWeather')) {
      try { state.lastWeather = JSON.parse(localStorage.getItem('lastWeather')); renderWeather(state.lastWeather); renderHourlyCharts(state.lastWeather); toast('Estás sin conexión — mostrando datos guardados'); } catch {}
    }
    // Geolocalización automática al abrir y guardar ciudad
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude } = pos.coords;
        const label = await nameFromCoords(latitude, longitude);
        await fetchWeather({ latitude, longitude, label });
        const exists = state.cities.some(c => Math.abs(c.latitude-latitude)<0.01 && Math.abs(c.longitude-longitude)<0.01) || state.cities.some(c=>c.label===label);
        if (!exists) { state.cities.push({ label, latitude, longitude }); saveCities(state.cities); renderCityList(label); toast(`Añadida: ${label}`); }
      }, (err) => { console.warn('Geolocalización denegada o error:', err); }, { enableHighAccuracy:true, timeout:10000 });
    }
  });
}

/* ---------- Toast ---------- */
function toast(msg){
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.position='fixed'; el.style.bottom='16px'; el.style.left='50%'; el.style.transform='translateX(-50%)';
  el.style.padding='10px 14px'; el.style.background='#232847'; el.style.border='1px solid #2b315e'; el.style.borderRadius='10px';
  el.style.color='#e8eaf6'; el.style.zIndex='9999';
  document.body.appendChild(el);
  setTimeout(()=> el.remove(), 2500);
}
