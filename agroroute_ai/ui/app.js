/* ===================================================================
   AgroRoute AI, app.js  (v3)
   - cores ÚNICAS por carga (paleta), não mais fixas por veículo
   - cadastro de FROTA (placa/tipo/estado) e checagem de disponibilidade
   - ciclo da carga: montando -> fechada -> calculada -> finalizada
   - histórico com detalhes (clientes + sequência do LRTA*)
   - ocorrências inline com desvio real + recálculo em cascata
   =================================================================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const FONTE = "'Plus Jakarta Sans',sans-serif";

/* paleta de cores por carga (técnica e sóbria) */
const PALETA = ["#22c55e", "#38bdf8", "#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#e879f9", "#60a5fa"];
// Capacidade máxima de carga por viagem (kg). Acima disso o sistema não deixa
// fechar/calcular a carga e orienta usar outro caminhão ou dividir a entrega.
const LIMITE_CARGA = 12000;

const state = {
  base: { nome: "Revenda AgroRoute · Patrocínio-MG", lat: -18.931325, lng: -46.971942 },
  config: { limite: 600, vel_pickup: 100, vel_truck: 70, knn: 3, peso_carga: 0.7 },
  tipos: {}, ocorrencias: [],
  cargas: [], veiculos: [],
  cargaEditando: null, dataHoje: "", horaHoje: "",
  modoMarcar: false, occSel: null, trechoTmp: [], ultimoLrta: null,
};
let _cli = 1, _occId = 1;
const novoCliId = () => _cli++;

/* ---------------- navegação ---------------- */
const PAGE = {
  dashboard: ["Dashboard", "Visão geral da operação logística"],
  cargas: ["Cargas do dia", "Crie e gerencie as cargas e seus veículos"],
  planejamento: ["Planejamento de Rotas", "Mapa interativo · rotas otimizadas por LRTA*"],
  "motor-ia": ["Motor de Busca Online", "Como o LRTA* aprende e replaneja"],
  historico: ["Histórico", "Cargas registradas por data"],
  config: ["Configurações", "Base, frota e parâmetros"],
};
function irPara(view) {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  $("#page-title").textContent = PAGE[view][0];
  $("#page-sub").textContent = PAGE[view][1];
  if (view === "planejamento" && map) setTimeout(() => { map.invalidateSize(); renderMapa(); }, 120);
  if (view === "dashboard") renderDashboard();
  if (view === "historico") carregarHistorico();
  if (view === "config") renderFrota();
  $("#sidebar").classList.remove("open"); $("#backdrop").classList.remove("show");
}
$$(".nav-item").forEach((b) => b.addEventListener("click", () => irPara(b.dataset.view)));
$("#mobToggle").addEventListener("click", () => { $("#sidebar").classList.toggle("open"); $("#backdrop").classList.toggle("show"); });
$("#backdrop").addEventListener("click", () => { $("#sidebar").classList.remove("open"); $("#backdrop").classList.remove("show"); });

/* ---------------- toast ---------------- */
function toast(msg, tipo = "info") {
  const icons = { ok: '<path d="M20 6 9 17l-5-5"/>', err: '<path d="M18 6 6 18M6 6l12 12"/>', info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>' };
  const el = document.createElement("div");
  el.className = "toast " + tipo;
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icons[tipo]}</svg><span>${msg}</span>`;
  $("#toast-wrap").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(10px)"; el.style.transition = ".3s"; setTimeout(() => el.remove(), 300); }, 3600);
}

/* ---------------- helpers ---------------- */
function recomendarVeiculo(peso) {
  if (peso <= state.config.limite) return { tipo: "Pickup", vel: state.config.vel_pickup, classe: "pickup" };
  return { tipo: "Caminhão", vel: state.config.vel_truck, classe: "truck" };
}
const corDe = (carga) => carga.cor || PALETA[0];
function corDisponivel() {
  const usadas = new Set(state.cargas.map((c) => c.cor));
  for (const c of PALETA) if (!usadas.has(c)) return c;
  return PALETA[state.cargas.length % PALETA.length];
}
const svgTruck = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="1.5"/><circle cx="18.5" cy="18.5" r="1.5"/></svg>';
const svgPickup = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 17H3V6h11v11h-3M9 17h6m4 0h2v-5l-3-4h-3v9"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/></svg>';
const cargaById = (id) => state.cargas.find((c) => c.id === id);

/* ============ MAPA ============ */
let map, layerMarkers, layerRoutes, layerOcc;
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([state.base.lat, state.base.lng], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  layerRoutes = L.layerGroup().addTo(map);
  layerMarkers = L.layerGroup().addTo(map);
  layerOcc = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
  setTimeout(() => map.invalidateSize(), 200);
}
function divIcon(html, size) { return L.divIcon({ html, className: "", iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] }); }
function cursorCross(on) { const m = $("#map"); if (m) m.classList.toggle("cursor-cross", on); }
function mostrarHint(txt) { $("#click-hint-txt").textContent = txt; $("#click-hint").classList.add("show"); }
function esconderHint() { $("#click-hint").classList.remove("show"); cursorCross(false); }
$("#click-cancel").addEventListener("click", () => { state.modoMarcar = false; state.occSel = null; state.trechoTmp = []; $$(".ot-type").forEach((x) => x.classList.remove("sel")); esconderHint(); });

function onMapClick(e) {
  const { lat, lng } = e.latlng;
  if (state.modoMarcar) {
    $("#f-lat").value = lat.toFixed(5); $("#f-lng").value = lng.toFixed(5);
    state.modoMarcar = false; esconderHint(); toast("Coordenada capturada.", "ok"); irPara("cargas"); return;
  }
  if (state.occSel) {
    const t = state.tipos[state.occSel];
    if (t.forma === "ponto") { addOcorrenciaPonto(state.occSel, lat, lng); }
    else {
      state.trechoTmp.push([lat, lng]);
      if (state.trechoTmp.length === 1) {
        mostrarHint(`Trecho: clique no 2º ponto para fechar "${t.nome}".`);
        L.circleMarker([lat, lng], { radius: 5, color: t.cor, fillColor: t.cor, fillOpacity: 1 }).addTo(layerOcc);
      } else { addOcorrenciaTrecho(state.occSel, state.trechoTmp.slice()); state.trechoTmp = []; }
    }
  }
}
function renderMapa() {
  if (!map) return;
  layerMarkers.clearLayers(); layerRoutes.clearLayers(); layerOcc.clearLayers();
  L.marker([state.base.lat, state.base.lng], { icon: divIcon(
    '<div class="mk mk-base"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l8-4 8 4v14M9 21v-6h6v6"/></svg></div>', [38, 38]) })
    .bindTooltip(state.base.nome, { direction: "top" }).addTo(layerMarkers);

  state.cargas.forEach((carga) => {
    const cor = corDe(carga);
    const ordemMap = {};
    if (carga.plano) carga.plano.ordem.forEach((id, i) => (ordemMap[id] = i + 1));
    carga.clientes.forEach((c) => {
      const ord = ordemMap["c" + c.id];
      L.marker([c.lat, c.lng], { icon: divIcon(
        `<div class="mk" style="width:28px;height:28px;border-radius:50%;background:${cor};border:2px solid #fff;color:#08120d;font-weight:700;font-family:${FONTE};font-size:12px;display:grid;place-items:center;box-shadow:0 4px 12px -3px rgba(0,0,0,.6)">${ord || "•"}</div>`, [28, 28]) })
        .bindTooltip(`<b>${c.fazenda || c.nome}</b><br>${c.nome} · ${c.peso} kg<br>${carga.id}${ord ? " · entrega nº " + ord : ""}`, { direction: "top" })
        .addTo(layerMarkers);
    });
    if (carga.plano) {
      carga.plano.trechos.forEach((tr) => {
        if (!tr.geometria || tr.geometria.length < 2) return;
        if (tr.bloqueado) {
          // trecho sem alternativa: desenha a rota original tracejada em vermelho
          L.polyline(tr.geometria, { color: "#f43f5e", weight: 5, opacity: 0.15 }).addTo(layerRoutes);
          L.polyline(tr.geometria, { color: "#f43f5e", weight: 3, opacity: 0.9, dashArray: "3 9", lineCap: "round" }).addTo(layerRoutes);
          return;
        }
        const op = tr.retorno ? 0.45 : 0.95, dash = tr.retorno ? "6 8" : null;
        L.polyline(tr.geometria, { color: cor, weight: 5, opacity: op * 0.22 }).addTo(layerRoutes);
        L.polyline(tr.geometria, { color: cor, weight: 3.2, opacity: op, dashArray: dash, lineCap: "round" }).addTo(layerRoutes);
        if (tr.via === "contorno") {
          // marca visual de que este trecho é um DESVIO
          const mid = tr.geometria[Math.floor(tr.geometria.length / 2)];
          L.marker(mid, { icon: divIcon('<div class="mk-desvio" title="Desvio aplicado">↺</div>', [22, 22]) }).addTo(layerRoutes);
        }
      });
    }
  });
  atualizarAvisoMapa();

  state.ocorrencias.forEach((oc) => {
    const t = state.tipos[oc.tipo];
    const aoVivo = oc.fonte === "clima";
    const cor = aoVivo ? "#22d3ee" : t.cor;   // chuva real = ciano vivo
    const intLbl = aoVivo ? `Chuva ${oc.intensidade} · ${oc.mm} mm/h` : t.desc;
    const tip = aoVivo
      ? `<b>Chuva ao vivo</b> <span style="color:#22d3ee">●</span><br>${oc.ref ? oc.ref + "<br>" : ""}${intLbl}<br><i>fonte: Open-Meteo</i>`
      : `<b>${t.nome}</b><br>${t.desc}`;
    if (oc.forma === "ponto") {
      L.circle([oc.lat, oc.lng], { radius: (t.raio_km || 1) * 1000, color: cor, weight: aoVivo ? 2 : 1.5, fillColor: cor, fillOpacity: aoVivo ? 0.14 : 0.1, dashArray: aoVivo ? "5 6" : null }).addTo(layerOcc);
      const ico = aoVivo
        ? `<div class="mk-occ mk-clima" style="background:${cor}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 13v5m-4-3v5m8-6v3M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3"/></svg></div>`
        : `<div class="mk-occ" style="background:${cor}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${t.icon || ""}</svg></div>`;
      L.marker([oc.lat, oc.lng], { icon: divIcon(ico, [30, 30]) }).bindTooltip(tip, { direction: "top" }).addTo(layerOcc);
    } else {
      L.polyline(oc.pontos, { color: cor, weight: (t.buffer_km || 1) * 14, opacity: 0.18, lineCap: "round" }).addTo(layerOcc);
      L.polyline(oc.pontos, { color: cor, weight: 4, opacity: 0.9 }).addTo(layerOcc);
      L.marker(oc.pontos[Math.floor(oc.pontos.length / 2)], { icon: divIcon(`<div class="mk-occ" style="background:${cor}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${t.icon || ""}</svg></div>`, [30, 30]) })
        .bindTooltip(tip, { direction: "top" }).addTo(layerOcc);
    }
  });

  const pts = [[state.base.lat, state.base.lng]];
  state.cargas.forEach((c) => c.clientes.forEach((cl) => pts.push([cl.lat, cl.lng])));
  if (pts.length > 1) { try { map.fitBounds(pts, { padding: [70, 70], maxZoom: 13 }); } catch (e) {} }
  atualizarBadgeReais();
}
function atualizarAvisoMapa() {
  const el = $("#map-aviso"); if (!el) return;
  const ativas = state.cargas.filter((c) => c.estado !== "finalizada" && c.plano);
  const desvios = [], bloqueios = [];
  ativas.forEach((c) => {
    if (!c.plano) return;
    if ((c.plano.inacessiveis || []).length) bloqueios.push(...c.plano.inacessiveis);
    if ((c.plano.trechos || []).some((t) => t.via === "contorno")) desvios.push(c.id);
  });
  if (bloqueios.length) {
    el.className = "map-aviso erro"; el.style.display = "";
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg> <span>Sem rota alternativa até <b>${[...new Set(bloqueios)].join(", ")}</b>, trecho mostrado tracejado em vermelho.</span>`;
  } else if (desvios.length) {
    el.className = "map-aviso ok"; el.style.display = "";
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8"/></svg> <span>Rota recalculada: <b>desvio aplicado</b> por causa de uma ocorrência (marcado com ↺).</span>`;
  } else {
    el.style.display = "none";
  }
}
function atualizarBadgeReais() {
  const planos = state.cargas.filter((c) => c.plano);
  const b = $("#map-badge"), txt = $("#map-badge-txt");
  if (!planos.length) { b.classList.remove("offline"); txt.textContent = "Estradas reais (OSRM)"; return; }
  if (planos.some((c) => c.plano.rotas_reais)) { b.classList.remove("offline"); txt.textContent = "Estradas reais (OSRM)"; }
  else { b.classList.add("offline"); txt.textContent = "Modo offline: linha reta"; }
}

/* ============ FROTA ============ */
function veiculoDisponivel(tipo) { return state.veiculos.find((v) => v.tipo === tipo && v.estado === "disponível"); }
function veiculoPorPlaca(placa) { return state.veiculos.find((v) => v.placa === placa); }
async function salvarVeiculo(v) { try { await fetch("/api/veiculos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) }); } catch (e) {} }
function renderFrota() {
  $("#frota-count").textContent = state.veiculos.length + " veículos";
  const box = $("#frota-list");
  if (!state.veiculos.length) { box.innerHTML = '<div class="empty"><div>Nenhum veículo cadastrado. Cadastre ao menos um para calcular rotas.</div></div>'; return; }
  box.innerHTML = state.veiculos.map((v) => {
    const truck = v.tipo === "Caminhão";
    const disp = v.estado === "disponível";
    return `<div class="frota-item">
      <div class="fv-ic" style="background:${truck ? "var(--green)" : "var(--petrol)"}">${truck ? svgTruck : svgPickup}</div>
      <div><div class="placa">${v.placa}</div><div class="fv-tipo">${v.tipo}</div></div>
      <span class="veh-estado ${disp ? "disponivel" : "rota"}">${v.estado}</span>
      <button class="icon-btn" data-del-veh="${v.placa}" style="border:1px solid var(--line)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg></button>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-del-veh]").forEach((b) => b.addEventListener("click", async () => {
    state.veiculos = state.veiculos.filter((v) => v.placa !== b.dataset.delVeh);
    try { await fetch("/api/veiculos/" + encodeURIComponent(b.dataset.delVeh), { method: "DELETE" }); } catch (e) {}
    renderFrota(); toast("Veículo removido.", "ok");
  }));
}
$("#btn-add-veiculo").addEventListener("click", async () => {
  const placa = $("#f-placa").value.trim().toUpperCase(), tipo = $("#f-veh-tipo").value;
  if (!placa) return toast("Informe a placa.", "err");
  if (veiculoPorPlaca(placa)) return toast("Placa já cadastrada.", "err");
  const v = { placa, tipo, estado: "disponível" };
  state.veiculos.push(v); await salvarVeiculo(v);
  $("#f-placa").value = ""; renderFrota(); toast(`Veículo ${placa} cadastrado.`, "ok");
});

/* ============ CARGAS ============ */
$("#btn-nova-carga").addEventListener("click", iniciarCarga);
function iniciarCarga() {
  const carga = {
    id: `CRG-${state.dataHoje.replace(/-/g, "")}-${String(state.cargas.length + 1).padStart(3, "0")}`,
    data_criacao: state.dataHoje, hora_criacao: state.horaHoje,
    estado: "montando", clientes: [], peso_total: 0,
    veiculo: recomendarVeiculo(0), cor: corDisponivel(), veiculo_placa: null, plano: null,
  };
  state.cargas.unshift(carga); state.cargaEditando = carga.id;
  renderCargas(); abrirEditor(carga.id);
}
function abrirEditor(id) {
  state.cargaEditando = id;
  const carga = cargaById(id);
  $("#carga-editor").style.display = "block";
  $("#editor-titulo").innerHTML = `${carga.id} <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${corDe(carga)};margin-left:6px;vertical-align:middle"></span>`;
  $("#editor-sub").textContent = `Criada às ${carga.hora_criacao} · ${carga.data_criacao}`;
  $("#editor-ic").innerHTML = carga.veiculo.classe === "truck" ? svgTruck : svgPickup;
  atualizarEstadoEditor(); renderEditorResumo(); renderEditorTbl();
  $("#carga-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}
function atualizarEstadoEditor() {
  atualizarFabCalc();
  const carga = cargaById(state.cargaEditando); if (!carga) return;
  const badge = $("#editor-estado"); badge.className = "estado-badge " + carga.estado; badge.textContent = carga.estado;
  $("#btn-fechar-carga").style.display = (carga.estado === "montando") ? "" : "none";
  $("#btn-calcular-carga").style.display = (carga.estado === "fechada") ? "" : "none";
}
$("#editor-fechar-x").addEventListener("click", () => { $("#carga-editor").style.display = "none"; state.cargaEditando = null; });

$("#btn-pin").addEventListener("click", () => {
  state.modoMarcar = true; cursorCross(true);
  mostrarHint("Clique no local da fazenda no mapa."); toast("Clique no mapa para capturar a coordenada.", "info"); irPara("planejamento");
});
$("#btn-add-cliente").addEventListener("click", () => {
  const carga = cargaById(state.cargaEditando); if (!carga) return toast("Inicie uma carga primeiro.", "err");
  if (carga.estado === "calculada" || carga.estado === "finalizada") reabrirParaEdicao(carga);
  const nome = $("#f-nome").value.trim(), fazenda = $("#f-fazenda").value.trim();
  const lat = parseFloat($("#f-lat").value), lng = parseFloat($("#f-lng").value), peso = parseFloat($("#f-peso").value);
  if (!nome) return toast("Informe o nome do cliente.", "err");
  if (isNaN(lat) || isNaN(lng)) return toast("Latitude e longitude devem ser números.", "err");
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return toast("Coordenadas fora do intervalo válido.", "err");
  if (isNaN(peso) || peso <= 0) return toast("Informe um peso válido (kg).", "err");
  carga.clientes.push({ id: novoCliId(), nome, fazenda, lat, lng, peso });
  ["f-nome", "f-fazenda", "f-lat", "f-lng", "f-peso"].forEach((id) => ($("#" + id).value = ""));
  recomputarCarga(carga); renderEditorResumo(); renderEditorTbl(); renderCargas(); renderMapa();
  toast(`Cliente "${nome}" adicionado.`, "ok");
});
function recomputarCarga(carga) {
  carga.peso_total = carga.clientes.reduce((s, c) => s + c.peso, 0);
  carga.veiculo = recomendarVeiculo(carga.peso_total);
  $("#editor-ic").innerHTML = carga.veiculo.classe === "truck" ? svgTruck : svgPickup;
}
function renderEditorResumo() {
  const carga = cargaById(state.cargaEditando); if (!carga) return;
  $("#cargo-peso").innerHTML = carga.peso_total + '<small style="font-size:16px;color:var(--txt-dim)"> kg</small>';
  $("#cargo-count").textContent = carga.clientes.length;
  const v = carga.veiculo, box = $("#vehicle-rec");
  const excede = carga.peso_total > LIMITE_CARGA;
  const disp = carga.veiculo_placa ? veiculoPorPlaca(carga.veiculo_placa) : veiculoDisponivel(v.tipo);
  box.className = "vehicle-rec " + v.classe + ((disp && !excede) ? "" : " indisponivel");
  $("#vrec-name").innerHTML = `${v.tipo}${disp ? ` <span class="vrec-placa">${disp.placa}</span>` : ""}`;
  if (excede) {
    $("#vrec-detail").innerHTML = `<span style="color:var(--red)">Carga acima de ${LIMITE_CARGA.toLocaleString("pt-BR")} kg, divida ou use outro caminhão</span>`;
  } else {
    $("#vrec-detail").innerHTML = disp
      ? `${v.vel} km/h · <span style="color:var(--green)">veículo disponível</span>`
      : `${v.vel} km/h · <span style="color:var(--red)">nenhum ${v.tipo.toLowerCase()} livre</span>`;
  }
  $("#vrec-ic").innerHTML = v.classe === "truck" ? svgTruck : svgPickup;
}
function renderEditorTbl() {
  const carga = cargaById(state.cargaEditando); if (!carga) return;
  const wrap = $("#editor-tbl");
  if (!carga.clientes.length) { wrap.innerHTML = '<div class="empty"><div>Nenhum cliente nesta carga ainda.</div></div>'; return; }
  const rows = carga.clientes.map((c, i) => `<tr>
    <td><b>${i + 1}</b></td><td>${c.nome}</td><td>${c.fazenda || "-"}</td>
    <td style="font-family:${FONTE};color:var(--txt-dim)">${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}</td>
    <td><span class="chip chip-green">${c.peso} kg</span></td>
    <td><button class="icon-btn" data-del="${c.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button></td></tr>`).join("");
  wrap.innerHTML = `<table class="tbl"><thead><tr><th>#</th><th>Cliente</th><th>Fazenda</th><th>Coordenadas</th><th>Peso</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    if (carga.estado === "calculada" || carga.estado === "finalizada") reabrirParaEdicao(carga);
    carga.clientes = carga.clientes.filter((c) => c.id != b.dataset.del);
    recomputarCarga(carga); renderEditorResumo(); renderEditorTbl(); renderCargas(); renderMapa();
  }));
}
function reabrirParaEdicao(carga) {
  if (carga.veiculo_placa) { const v = veiculoPorPlaca(carga.veiculo_placa); if (v) { v.estado = "disponível"; salvarVeiculo(v); } carga.veiculo_placa = null; }
  carga.estado = "montando"; carga.plano = null;
  atualizarEstadoEditor(); renderCargas(); renderMapa();
  toast("Carga reaberta. Feche e recalcule após as alterações.", "info");
}

$("#btn-fechar-carga").addEventListener("click", () => {
  const carga = cargaById(state.cargaEditando); if (!carga) return;
  if (!carga.clientes.length) return toast("Adicione ao menos um cliente.", "err");
  if (carga.peso_total > LIMITE_CARGA) {
    return toast(`Carga de ${carga.peso_total.toLocaleString("pt-BR")} kg excede o limite de ${LIMITE_CARGA.toLocaleString("pt-BR")} kg do caminhão. Use outro caminhão ou divida em mais de uma carga.`, "err");
  }
  carga.estado = "fechada"; atualizarEstadoEditor(); renderCargas(); salvarCarga(carga);
  toast("Carga fechada. Agora calcule a rota.", "ok");
});
$("#btn-calcular-carga").addEventListener("click", async () => {
  const carga = cargaById(state.cargaEditando); if (!carga) return;
  if (await calcularCarga(carga)) irPara("planejamento");
});
async function calcularCarga(carga) {
  // LIMITE DE CAPACIDADE: não planeja carga acima do máximo do caminhão.
  if (carga.peso_total > LIMITE_CARGA) {
    toast(`Carga de ${carga.peso_total.toLocaleString("pt-BR")} kg acima do limite de ${LIMITE_CARGA.toLocaleString("pt-BR")} kg. Use outro caminhão ou divida a carga.`, "err");
    return false;
  }
  // checagem de FROTA: precisa de um veículo do tipo certo disponível
  if (!carga.veiculo_placa) {
    const disp = veiculoDisponivel(carga.veiculo.tipo);
    if (!disp) { toast(`Nenhum ${carga.veiculo.tipo} disponível. Cadastre/aguarde em Configurações → Frota.`, "err"); return false; }
    carga.veiculo_placa = disp.placa; disp.estado = "em rota"; salvarVeiculo(disp); renderFrota();
  }
  toast(`Calculando rota de ${carga.id} com LRTA*...`, "info");
  mostrarCarregando(`Calculando rota de ${carga.id}...`);
  try {
    const resp = await fetch("/api/planejar", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: state.base, clientes: carga.clientes, ocorrencias: state.ocorrencias, config: state.config }) });
    const data = await resp.json();
    if (data.erro) { toast(data.erro, "err"); return false; }
    carga.plano = data; carga.estado = "calculada"; carga.veiculo = { ...data.veiculo };
    state.ultimoLrta = { lrta: data.lrta, nos: data.nos };
    atualizarEstadoEditor(); renderCargas(); renderMapa(); renderRoutePanel(); renderMotorIA(); atualizarKPIs(); renderDashboard();
    salvarCarga(carga);
    if (!data.rota_ok) {
      const nomes = (data.inacessiveis || []).join(", ");
      toast(nomes ? `Sem rota de acesso a: ${nomes} (trecho interditado sem alternativa).` : "Há trecho sem alternativa de rota.", "err");
    } else if ((data.trechos || []).some((t) => t.via === "contorno")) {
      toast(`Rota de ${carga.id} recalculada com desvio (contorno por estrada).`, "ok");
    } else {
      toast(`Rota de ${carga.id} pronta (com retorno à base).`, "ok");
    }
    return true;
  } catch (e) { toast("Servidor não respondeu. Rode 'python app.py'.", "err"); return false; }
  finally { esconderCarregando(); }
}
function finalizarCarga(carga) {
  if (carga.veiculo_placa) { const v = veiculoPorPlaca(carga.veiculo_placa); if (v) { v.estado = "disponível"; salvarVeiculo(v); } }
  carga.estado = "finalizada"; salvarCarga(carga); renderCargas(); renderFrota(); renderMapa();
  toast(`${carga.id} finalizada. Veículo liberado.`, "ok");
}

function renderCargas() {
  const wrap = $("#cargas-cards");
  $("#cargas-badge").textContent = state.cargas.length;
  $("#cargas-badge").style.display = state.cargas.length ? "inline-block" : "none";
  if (!state.cargas.length) {
    wrap.innerHTML = '<div class="empty" style="grid-column:1/-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 11l18-5v12L3 14v-3z"/></svg><div>Nenhuma carga hoje. Clique em "Iniciar Nova Carga".</div></div>';
    return;
  }
  wrap.innerHTML = state.cargas.map((c) => {
    const cor = corDe(c), truck = c.veiculo.classe === "truck";
    const stats = c.plano ? `<div class="cc-stats">
        <div class="cc-stat"><div class="v">${c.plano.distancia_total.toFixed(0)}</div><div class="l">km total</div></div>
        <div class="cc-stat"><div class="v">${c.plano.tempo_min}</div><div class="l">min</div></div>
        <div class="cc-stat"><div class="v" style="color:var(--green)">${c.plano.economia.toFixed(0)}</div><div class="l">km econ.</div></div>
      </div>` : "";
    const aviso = (c.plano && !c.plano.rota_ok)
      ? `<div class="cc-aviso"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg> Sem rota de acesso a: ${(c.plano.inacessiveis || []).join(", ") || "um trecho"}.</div>`
      : "";
    const placa = c.veiculo_placa ? ` · ${c.veiculo_placa}` : "";
    const acoes = `<div class="cc-actions">
        ${c.estado !== "finalizada" ? `<button class="btn btn-ghost" data-edit="${c.id}">Editar</button>` : ""}
        ${c.estado === "fechada" ? `<button class="btn btn-primary" data-calc="${c.id}">Calcular</button>` : ""}
        ${c.plano ? `<button class="btn btn-petrol" data-ver="${c.id}">Ver no mapa</button>` : ""}
        ${c.estado === "calculada" ? `<button class="btn btn-primary" data-fim="${c.id}">Finalizar</button>` : ""}
        <button class="icon-btn" data-del-carga="${c.id}" style="border:1px solid var(--line)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg></button>
      </div>`;
    return `<div class="carga-card ${c.estado}" style="border-left-color:${cor}">
      <div class="cc-top"><span class="cc-color-dot" style="background:${cor};width:11px;height:11px"></span><span class="cc-id">${c.id}</span><span class="cc-hora">${c.hora_criacao}</span><span class="estado-badge ${c.estado}">${c.estado}</span></div>
      <span class="cc-veh ${c.veiculo.classe}">${truck ? svgTruck : svgPickup} ${c.veiculo.tipo}${placa}</span>
      <div class="cc-meta">${c.clientes.length} cliente(s) · ${c.peso_total} kg · ${c.veiculo.vel} km/h</div>
      ${stats}${aviso}${acoes}
    </div>`;
  }).join("");
  wrap.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => abrirEditor(b.dataset.edit)));
  wrap.querySelectorAll("[data-calc]").forEach((b) => b.addEventListener("click", () => { state.cargaEditando = b.dataset.calc; calcularCarga(cargaById(b.dataset.calc)).then((ok) => { if (ok) irPara("planejamento"); }); }));
  wrap.querySelectorAll("[data-ver]").forEach((b) => b.addEventListener("click", () => { irPara("planejamento"); const c = cargaById(b.dataset.ver); if (c && c.clientes[0]) map.setView([c.clientes[0].lat, c.clientes[0].lng], 12, { animate: true }); }));
  wrap.querySelectorAll("[data-fim]").forEach((b) => b.addEventListener("click", () => finalizarCarga(cargaById(b.dataset.fim))));
  wrap.querySelectorAll("[data-del-carga]").forEach((b) => b.addEventListener("click", () => excluirCarga(b.dataset.delCarga)));
}
async function excluirCarga(id) {
  const c = cargaById(id);
  if (c && c.veiculo_placa) { const v = veiculoPorPlaca(c.veiculo_placa); if (v) { v.estado = "disponível"; salvarVeiculo(v); } }
  state.cargas = state.cargas.filter((c) => c.id !== id);
  if (state.cargaEditando === id) { $("#carga-editor").style.display = "none"; state.cargaEditando = null; }
  try { await fetch("/api/cargas/" + id, { method: "DELETE" }); } catch (e) {}
  renderCargas(); renderFrota(); renderMapa(); renderRoutePanel(); atualizarKPIs(); renderDashboard();
  toast("Carga excluída.", "ok");
}
async function salvarCarga(carga) {
  try { await fetch("/api/cargas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(carga) }); } catch (e) {}
}

/* ============ PAINEL DE ROTAS ============ */
function renderRoutePanel() {
  const calc = state.cargas.filter((c) => c.plano && c.plano.rota_ok);
  const body = $("#rp-body");
  if (!calc.length) { body.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 20l-5.5-3V4L9 7m0 13l6-3m-6 3V7"/></svg><div>Calcule a rota de uma carga para vê-la aqui.</div></div>'; return; }
  body.innerHTML = calc.map((c) => {
    const cor = corDe(c), p = c.plano, nb = {}; p.nos.forEach((n) => (nb[n.id] = n));
    const seq = p.ordem.map((id, i) => `<div class="seq-item" data-lat="${nb[id].lat}" data-lng="${nb[id].lng}"><div class="seq-num" style="background:${cor}">${i + 1}º</div><div class="seq-info"><b>${nb[id].nome}</b><span>${(p.trechos[i] && p.trechos[i].custo != null) ? p.trechos[i].custo.toFixed(1) + " km" : ""}</span></div></div>`).join("");
    return `<div class="rp-carga">
      <div class="rp-carga-h"><span class="cdot" style="background:${cor}"></span><b>${c.id}</b><span class="mini">${c.veiculo.tipo} · ${p.distancia_total.toFixed(0)} km</span></div>
      <div class="rp-carga-body">
        <div class="rp-mini-stats">
          <div class="s"><div class="v">${p.distancia_total.toFixed(1)}</div><div class="l">km c/ volta</div></div>
          <div class="s"><div class="v">${p.tempo_min}</div><div class="l">min</div></div>
          <div class="s"><div class="v" style="color:var(--green)">${p.economia.toFixed(1)}</div><div class="l">km vs ordem aleatória${p.economia_pct ? " (" + p.economia_pct + "%)" : ""}</div></div>
        </div>
        <div class="seq-title">Sequência (volta à base ao fim)</div>${seq}
      </div></div>`;
  }).join("");
  body.querySelectorAll(".seq-item").forEach((it) => it.addEventListener("click", () => map.setView([+it.dataset.lat, +it.dataset.lng], 13, { animate: true })));
}

/* ============ MOTOR IA ============ */
function renderMotorIA() {
  const info = state.ultimoLrta; if (!info) return;
  const ia = info.lrta, nos = info.nos;
  $("#m-trials").textContent = ia.trials; $("#m-nodes").textContent = ia.nos_expandidos; $("#m-updates").textContent = ia.atualizacoes_h;
  $("#htable-empty").style.display = "none";
  const nomeDe = (id) => { const n = nos.find((x) => x.id === id); return n ? n.nome : id; };
  $("#htable-body").innerHTML = nos.map((n) => {
    const hIni = ia.h_inicial[n.id] != null ? ia.h_inicial[n.id] : 0;
    const hApr = ia.H[n.id] != null ? ia.H[n.id] : hIni;
    return `<tr class="${ia.nos_atualizados.includes(n.id) ? "hflash" : ""}"><td>${n.nome}</td><td style="color:var(--txt-mut)">${hIni.toFixed(1)} km</td><td><span class="hbadge">${hApr.toFixed(1)} km</span></td></tr>`;
  }).join("");
  const linhas = (ia.log || []).slice(-40).map((l) => {
    if (l.t === "move") return `<div class="log-line">→ move <b>${nomeDe(l.de)}</b> ⇒ <b>${nomeDe(l.para)}</b> (custo ${l.custo.toFixed(1)} km)</div>`;
    if (l.t === "upd") return `<div class="log-line"><span class="upd">↑ aprende H(${nomeDe(l.no)}): ${l.de.toFixed(1)} → ${l.para.toFixed(1)} km</span></div>`;
    return "";
  }).join("");
  $("#log-box").innerHTML = linhas || '<div class="log-line">// rota direta, sem reajustes de H.</div>';
}

/* ===== Árvore de busca didática (autossuficiente, não depende de cálculo) =====
   Exemplo fixo: nós abstratos S(início) ... G(objetivo). Cada nó tem g (custo
   acumulado) e h (heurística), com f = g + h. A busca informada (estilo A* / LRTA)
   expande sempre o nó de MENOR f na fronteira. A animação mostra isso passo a passo. */
const TREE = {
  nodes: {
    S: { x: 380, y: 40, g: 0, h: 6, label: "S", sub: "início" },
    A: { x: 220, y: 140, g: 2, h: 3, label: "A" },
    B: { x: 540, y: 140, g: 4, h: 4, label: "B" },
    C: { x: 120, y: 250, g: 5, h: 2, label: "C" },
    D: { x: 320, y: 250, g: 4, h: 3, label: "D" },
    E: { x: 540, y: 250, g: 7, h: 5, label: "E" },
    G: { x: 120, y: 330, g: 7, h: 0, label: "G", sub: "objetivo" },
  },
  edges: [["S", "A"], ["S", "B"], ["A", "C"], ["A", "D"], ["B", "E"], ["C", "G"]],
  // ordem de expansão (best-first por f) e a narração de cada passo
  steps: [
    { expand: "S", reveal: ["A", "B"], txt: "Começamos em <b>S</b>. Expandimos S e descobrimos seus vizinhos <b>A</b> (f=2+3=5) e <b>B</b> (f=4+4=8). A fronteira agora tem A e B." },
    { expand: "A", reveal: ["C", "D"], txt: "Entre a fronteira {A=5, B=8}, o menor f é <b>A</b>. Expandimos A e descobrimos <b>C</b> (f=5+2=7) e <b>D</b> (f=4+3=7). Fronteira: {B=8, C=7, D=7}." },
    { expand: "C", reveal: ["G"], txt: "Menor f da fronteira é <b>C</b> (=7). Expandimos C e chegamos ao vizinho <b>G</b> (f=7+0=7), que é o objetivo! Fronteira: {B=8, D=7, G=7}." },
    { expand: "G", reveal: [], txt: "<b>G</b> tem o menor f (=7) e é o <b>objetivo</b>. A busca termina. O caminho da solução é <b>S → A → C → G</b>.", path: ["S", "A", "C", "G"] },
  ],
};
let _tree = { i: -1, timer: null };
function treeSvgNodes(estado, pathSet) {
  // estado: {id: 'open'|'cur'|'closed'} ; desenha arestas + nós
  let edges = "";
  TREE.edges.forEach(([u, v]) => {
    const n1 = TREE.nodes[u], n2 = TREE.nodes[v];
    const onPath = pathSet && pathSet.has(u) && pathSet.has(v);
    edges += `<line x1="${n1.x}" y1="${n1.y}" x2="${n2.x}" y2="${n2.y}" class="tree-edge ${onPath ? "on-path" : ""}" ${estado[v] ? "" : 'stroke-dasharray="4 5" opacity="0.25"'}/>`;
  });
  let nodes = "";
  Object.entries(TREE.nodes).forEach(([id, n]) => {
    const st = estado[id];
    if (!st) return; // ainda não descoberto
    const f = n.g + n.h;
    const cls = st === "cur" ? "cur" : st === "closed" ? "closed" : "open";
    const onPath = pathSet && pathSet.has(id);
    nodes += `<g class="tree-node ${cls} ${onPath ? "path" : ""}" style="--d:${id.charCodeAt(0) % 5 * 0.05}s">
      <circle cx="${n.x}" cy="${n.y}" r="22"/>
      <text class="tn-lbl" x="${n.x}" y="${n.y + 1}">${n.label}</text>
      <text class="tn-f" x="${n.x}" y="${n.y - 30}">f=${f}</text>
      <text class="tn-gh" x="${n.x}" y="${n.y + 38}">g=${n.g} h=${n.h}</text>
      ${n.sub ? `<text class="tn-sub" x="${n.x}" y="${n.y + 52}">${n.sub}</text>` : ""}
    </g>`;
  });
  return edges + nodes;
}
function treeRender(stepIdx) {
  _tree.i = stepIdx;
  const estado = {};
  const pathSet = null;
  // reconstrói estado acumulado até stepIdx
  let solPath = null;
  estado["S"] = "open";
  for (let k = 0; k <= stepIdx; k++) {
    const s = TREE.steps[k];
    estado[s.expand] = "closed";
    s.reveal.forEach((r) => { if (!estado[r]) estado[r] = "open"; });
    if (k === stepIdx && s.expand) estado[s.expand] = (k === TREE.steps.length - 1) ? "closed" : "cur";
    if (s.path) solPath = s.path;
  }
  // nó atual em destaque (o expandido neste passo)
  if (stepIdx >= 0) {
    const cur = TREE.steps[stepIdx].expand;
    if (stepIdx < TREE.steps.length - 1) estado[cur] = "cur";
  }
  const ps = solPath ? new Set(solPath) : null;
  $("#tree-svg").innerHTML = treeSvgNodes(estado, ps);
  $("#tree-narr").innerHTML = stepIdx < 0 ? "Clique em <b>Reproduzir</b> para ver a busca explorar os nós, um a um." : TREE.steps[stepIdx].txt;
  const pct = ((stepIdx + 1) / TREE.steps.length) * 100;
  $("#tree-bar").style.width = Math.max(0, pct) + "%";
  $("#tree-step-lbl").textContent = stepIdx < 0 ? "" : `Passo ${stepIdx + 1} de ${TREE.steps.length}` + (stepIdx === TREE.steps.length - 1 ? " · objetivo alcançado" : "");
}
function treeStop() { if (_tree.timer) { clearInterval(_tree.timer); _tree.timer = null; } const b = $("#tree-play"); if (b) b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-14 9V3z"/></svg> Reproduzir'; }
function initArvore() {
  treeRender(-1);
  $("#tree-next").addEventListener("click", () => { treeStop(); if (_tree.i < TREE.steps.length - 1) treeRender(_tree.i + 1); });
  $("#tree-prev").addEventListener("click", () => { treeStop(); if (_tree.i > -1) treeRender(_tree.i - 1); });
  $("#tree-reset").addEventListener("click", () => { treeStop(); treeRender(-1); });
  $("#tree-play").addEventListener("click", () => {
    if (_tree.timer) { treeStop(); return; }
    if (_tree.i >= TREE.steps.length - 1) treeRender(-1);
    $("#tree-play").innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pausar';
    _tree.timer = setInterval(() => {
      if (_tree.i >= TREE.steps.length - 1) { treeStop(); return; }
      treeRender(_tree.i + 1);
    }, 1700);
  });
}

/* ============ OCORRÊNCIAS ============ */
$("#ot-toggle").addEventListener("click", (e) => { e.stopPropagation(); $("#occ-toolbar").classList.toggle("collapsed"); });
$("#ot-head").addEventListener("click", () => $("#occ-toolbar").classList.toggle("collapsed"));

/* ===== Indicador de carregamento persistente (fica até terminar) ===== */
let _carregandoN = 0;
function mostrarCarregando(txt) {
  _carregandoN++;
  const el = $("#map-loading"); if (!el) return;
  $("#map-loading-txt").textContent = txt || "Processando...";
  el.style.display = "";
}
function esconderCarregando() {
  _carregandoN = Math.max(0, _carregandoN - 1);
  if (_carregandoN === 0) { const el = $("#map-loading"); if (el) el.style.display = "none"; }
}

/* ===== Clima real (Open-Meteo), varredura de chuva na REGIÃO ===== */
async function buscarClima() {
  const btn = $("#btn-clima"); btn.classList.add("loading");
  $("#ot-clima-info").innerHTML = "Varrendo a região em busca de chuva ao vivo...";
  mostrarCarregando("Buscando chuva na região (Open-Meteo)...");
  try {
    const resp = await fetch("/api/clima", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base: state.base, raio_km: 100, passo_km: 15 }) });
    const data = await resp.json();
    state.ocorrencias = state.ocorrencias.filter((o) => o.fonte !== "clima");
    (data.ocorrencias || []).forEach((o) => state.ocorrencias.push({ ...o, id: "clima" + _occId++ }));
    const n = (data.ocorrencias || []).length;
    const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    if (data.erro && !data.consultados) {
      $("#ot-clima-info").innerHTML = `<span style="color:var(--red)">Sem resposta da API de clima (verifique a internet).</span>`;
      toast("Não consegui consultar o clima agora.", "err");
    } else if (n === 0) {
      $("#ot-clima-info").innerHTML = `<span style="color:var(--txt-dim)">Nenhuma chuva relevante na região agora (${hora}). Varri ${data.consultados} pontos.</span>`;
      toast(`Região sem chuva relevante agora (${data.consultados} pontos checados).`, "ok");
    } else {
      $("#ot-clima-info").innerHTML = `<span style="color:var(--petrol)"><b>${n}</b> zona(s) de chuva ao vivo na região (${hora}).</span>`;
      toast(`${n} zona(s) de chuva real encontrada(s). Veja em ciano no mapa.`, "ok");
      // centraliza numa zona de chuva para o operador enxergar
      const z = data.ocorrencias[0]; if (z && map) map.setView([z.lat, z.lng], 10, { animate: true });
    }
    renderOccAtivas(); renderMapa(); recalcularTodas();
  } catch (e) {
    $("#ot-clima-info").innerHTML = `<span style="color:var(--red)">Falha ao consultar o clima.</span>`;
    toast("Falha ao consultar o clima.", "err");
  } finally { btn.classList.remove("loading"); esconderCarregando(); }
}
document.addEventListener("DOMContentLoaded", () => { const b = $("#btn-clima"); if (b) b.addEventListener("click", buscarClima); });

/* ===== Botão flutuante: calcular/recalcular rota direto no mapa ===== */
function atualizarFabCalc() {
  const fab = $("#map-fab-calc"); if (!fab) return;
  const emEd = cargaById(state.cargaEditando);
  const calculadas = state.cargas.filter((c) => c.estado === "calculada");
  const fechadas = state.cargas.filter((c) => c.estado === "fechada");
  let txt = "Calcular rota", show = false;
  if (emEd && (emEd.estado === "fechada" || emEd.estado === "montando")) { txt = `Calcular ${emEd.id}`; show = true; }
  else if (calculadas.length) { txt = "Recalcular rotas"; show = true; }
  else if (fechadas.length) { txt = "Calcular rotas"; show = true; }
  $("#map-fab-calc-txt").textContent = txt;
  fab.style.display = show ? "" : "none";
}
$("#map-fab-calc").addEventListener("click", async () => {
  const emEd = cargaById(state.cargaEditando);
  if (emEd && (emEd.estado === "fechada" || emEd.estado === "montando")) {
    if (emEd.estado === "montando") {
      if (!emEd.clientes.length) return toast("Adicione ao menos um cliente.", "err");
      emEd.estado = "fechada"; salvarCarga(emEd);
    }
    await calcularCarga(emEd); return;
  }
  const calculadas = state.cargas.filter((c) => c.estado === "calculada");
  const fechadas = state.cargas.filter((c) => c.estado === "fechada");
  if (calculadas.length) { recalcularTodas(); return; }
  if (fechadas.length) { for (const c of fechadas) await calcularCarga(c); return; }
  toast("Nenhuma carga para calcular. Crie e feche uma carga primeiro.", "info");
});
function renderOccToolbar() {
  $("#ot-types").innerHTML = Object.entries(state.tipos).map(([k, t]) => `
    <button class="ot-type" data-tipo="${k}">
      <div class="oic" style="background:${t.cor}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${t.icon || ""}</svg></div>
      <div><b>${t.nome}</b><span>${t.forma === "ponto" ? "raio " + t.raio_km + "km" : "trecho"}</span></div>
    </button>`).join("");
  $$(".ot-type").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    $$(".ot-type").forEach((x) => x.classList.remove("sel")); b.classList.add("sel");
    state.occSel = b.dataset.tipo; state.trechoTmp = []; cursorCross(true);
    const t = state.tipos[state.occSel];
    mostrarHint(t.forma === "ponto" ? `Clique no mapa: "${t.nome}" (raio ${t.raio_km} km).` : `Clique em 2 pontos: trecho de "${t.nome}".`);
  }));
  renderOccAtivas();
}
function renderOccAtivas() {
  const box = $("#ot-active");
  if (!state.ocorrencias.length) { box.innerHTML = ""; return; }
  box.innerHTML = state.ocorrencias.map((oc) => {
    const t = state.tipos[oc.tipo];
    const aoVivo = oc.fonte === "clima";
    const cor = aoVivo ? "#22d3ee" : t.cor;
    const rotulo = aoVivo
      ? `Chuva ${oc.intensidade} <span class="ao-vivo-badge">AO VIVO</span><br><small style="color:var(--txt-mut)">${oc.ref ? oc.ref + " · " : ""}${oc.mm} mm/h</small>`
      : t.nome;
    return `<div class="ot-active-item ${aoVivo ? "clima" : ""}"><div class="od" style="background:${cor}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${aoVivo ? '<path d="M16 13v5m-4-3v5m8-6v3M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3"/>' : (t.icon || "")}</svg></div><span style="flex:1;line-height:1.3">${rotulo}</span><button class="icon-btn" data-del-occ="${oc.id}" style="width:22px;height:22px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`;
  }).join("") + `<button class="ot-clear" id="ot-clear">Limpar todas as ocorrências</button>`;
  box.querySelectorAll("[data-del-occ]").forEach((b) => b.addEventListener("click", () => { state.ocorrencias = state.ocorrencias.filter((o) => o.id != b.dataset.delOcc); renderOccAtivas(); renderMapa(); recalcularTodas(); }));
  const cl = $("#ot-clear"); if (cl) cl.addEventListener("click", () => { state.ocorrencias = []; renderOccAtivas(); renderMapa(); recalcularTodas(); });
}
function addOcorrenciaPonto(tipo, lat, lng) { state.ocorrencias.push({ id: "o" + _occId++, tipo, forma: "ponto", lat, lng }); finalizarOcorrencia(tipo); }
function addOcorrenciaTrecho(tipo, pontos) { state.ocorrencias.push({ id: "o" + _occId++, tipo, forma: "trecho", pontos }); finalizarOcorrencia(tipo); }
function finalizarOcorrencia(tipo) {
  state.occSel = null; $$(".ot-type").forEach((x) => x.classList.remove("sel")); esconderHint();
  renderOccAtivas(); renderMapa();
  toast(`${state.tipos[tipo].nome} registrada. Recalculando rotas...`, "info");
  recalcularTodas();
}
async function recalcularTodas() {
  const calc = state.cargas.filter((c) => c.estado === "calculada");
  if (calc.length) mostrarCarregando("Recalculando rotas pelo LRTA*...");
  for (const c of calc) {
    try {
      const resp = await fetch("/api/planejar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base: state.base, clientes: c.clientes, ocorrencias: state.ocorrencias, config: state.config }) });
      const data = await resp.json();
      if (!data.erro) { c.plano = data; state.ultimoLrta = { lrta: data.lrta, nos: data.nos }; salvarCarga(c); }
    } catch (e) {}
  }
  renderMapa(); renderRoutePanel(); renderMotorIA(); renderCargas(); atualizarKPIs(); renderDashboard();
  if (calc.length) { esconderCarregando(); toast("Rotas recalculadas pelo LRTA*.", "ok"); }
}

/* ============ HISTÓRICO (com detalhes) ============ */
async function carregarHistorico() {
  try {
    const datas = await (await fetch("/api/datas")).json();
    const sel = $("#hist-data");
    const lista = datas.length ? datas : [state.dataHoje];
    sel.innerHTML = lista.map((d) => `<option value="${d}">${d.split("-").reverse().join("/")}${d === state.dataHoje ? " (hoje)" : ""}</option>`).join("");
    sel.onchange = () => mostrarHistorico(sel.value);
    mostrarHistorico(sel.value);
  } catch (e) {}
}
/* resumo do dia: km e entregas por veículo, finalizadas vs andamento */
function renderResumoHistorico(cargas) {
  const box = $("#hist-resumo"); if (!box) return;
  if (!cargas.length) { box.innerHTML = ""; return; }
  const comPlano = cargas.filter((c) => c.plano && c.plano.rota_ok);
  const kmTotal = comPlano.reduce((s, c) => s + c.plano.distancia_total, 0);
  const entregasTotal = cargas.reduce((s, c) => s + c.clientes.length, 0);
  const finalizadas = cargas.filter((c) => c.estado === "finalizada").length;
  const andamento = cargas.length - finalizadas;
  let truck = 0, pickup = 0;
  cargas.forEach((c) => (c.veiculo.classe === "truck" ? truck++ : pickup++));
  // agrega por placa
  const porVeic = {};
  cargas.forEach((c) => {
    const placa = c.veiculo_placa || "(sem veículo)";
    if (!porVeic[placa]) porVeic[placa] = { km: 0, entregas: 0, cargas: 0, tipo: c.veiculo.tipo, classe: c.veiculo.classe };
    porVeic[placa].cargas++; porVeic[placa].entregas += c.clientes.length;
    if (c.plano && c.plano.rota_ok) porVeic[placa].km += c.plano.distancia_total;
  });
  const linhasVeic = Object.entries(porVeic).map(([placa, v]) => `
    <div class="rv-item">
      <div class="rv-ic" style="background:${v.classe === "truck" ? "var(--green)" : "var(--petrol)"}">${v.classe === "truck" ? svgTruck : svgPickup}</div>
      <div class="rv-main"><div class="rv-placa">${placa}</div><div class="rv-sub">${v.tipo} · ${v.cargas} carga(s)</div></div>
      <div class="rv-stat"><b>${v.km.toFixed(0)}</b><span>km</span></div>
      <div class="rv-stat"><b>${v.entregas}</b><span>entregas</span></div>
    </div>`).join("");
  box.innerHTML = `
    <div class="resumo-kpis">
      <div class="rk"><div class="rk-v">${kmTotal.toFixed(0)}<small> km</small></div><div class="rk-l">Rodados no dia</div></div>
      <div class="rk"><div class="rk-v">${entregasTotal}</div><div class="rk-l">Entregas</div></div>
      <div class="rk"><div class="rk-v">${finalizadas}<small> / ${cargas.length}</small></div><div class="rk-l">Finalizadas</div></div>
      <div class="rk"><div class="rk-v">${andamento}</div><div class="rk-l">Em andamento</div></div>
      <div class="rk"><div class="rk-v">${truck}<small>🚚</small> ${pickup}<small>🛻</small></div><div class="rk-l">Caminhão / Pickup</div></div>
    </div>
    <div class="resumo-veic-title">Por veículo</div>
    <div class="resumo-veic">${linhasVeic}</div>`;
}

async function mostrarHistorico(data) {
  const wrap = $("#historico-cards");
  try {
    const cargas = await (await fetch("/api/cargas?data=" + data)).json();
    renderResumoHistorico(cargas);
    if (!cargas.length) { wrap.innerHTML = '<div class="empty" style="grid-column:1/-1"><div>Nenhuma carga nesta data.</div></div>'; return; }
    wrap.innerHTML = cargas.map((c, idx) => {
      const cor = c.cor || PALETA[idx % PALETA.length], truck = c.veiculo.classe === "truck";
      const stats = c.plano ? `<div class="cc-stats"><div class="cc-stat"><div class="v">${c.plano.distancia_total.toFixed(0)}</div><div class="l">km</div></div><div class="cc-stat"><div class="v">${c.plano.tempo_min}</div><div class="l">min</div></div><div class="cc-stat"><div class="v" style="color:var(--green)">${c.plano.economia.toFixed(0)}</div><div class="l">econ.</div></div></div>` : "";
      // detalhes: clientes + sequência do LRTA*
      const nb = {}; if (c.plano) c.plano.nos.forEach((n) => (nb[n.id] = n));
      const ordemPos = {}; if (c.plano) c.plano.ordem.forEach((id, i) => (ordemPos[id] = i + 1));
      const linhasCli = c.clientes.map((cl) => {
        const pos = ordemPos["c" + cl.id];
        return `<tr><td>${pos ? `<span class="seqn" style="background:${cor}">${pos}</span>` : "•"}</td><td>${cl.nome}</td><td style="color:var(--txt-dim)">${cl.fazenda || "-"}</td><td>${cl.peso} kg</td><td style="color:var(--txt-mut);font-size:11px">${cl.lat.toFixed(3)}, ${cl.lng.toFixed(3)}</td></tr>`;
      }).join("");
      const detalhe = `<div class="hist-det" id="hd-${c.id}">
        <table class="mini-tbl"><tbody>${linhasCli}</tbody></table>
        ${c.veiculo_placa ? `<div class="cc-meta" style="margin-top:8px">Veículo: <b style="font-family:${FONTE}">${c.veiculo_placa}</b></div>` : ""}
      </div>`;
      return `<div class="carga-card ${c.estado}" style="border-left-color:${cor}">
        <div class="cc-top"><span class="cc-color-dot" style="background:${cor};width:11px;height:11px"></span><span class="cc-id">${c.id}</span><span class="cc-hora">${c.hora_criacao}</span><span class="estado-badge ${c.estado}">${c.estado}</span></div>
        <span class="cc-veh ${c.veiculo.classe}">${truck ? svgTruck : svgPickup} ${c.veiculo.tipo} · ${c.peso_total} kg</span>
        <div class="cc-meta">${c.clientes.length} cliente(s)</div>${stats}
        <button class="hist-toggle" data-hd="${c.id}">Ver detalhes dos clientes ▾</button>${detalhe}</div>`;
    }).join("");
    wrap.querySelectorAll("[data-hd]").forEach((b) => b.addEventListener("click", () => { const d = $("#hd-" + b.dataset.hd); d.classList.toggle("open"); b.textContent = d.classList.contains("open") ? "Ocultar detalhes ▴" : "Ver detalhes dos clientes ▾"; }));
  } catch (e) { wrap.innerHTML = '<div class="empty" style="grid-column:1/-1"><div>Erro ao carregar histórico.</div></div>'; }
}

/* ============ KPIs / DASHBOARD ============ */
function atualizarKPIs() {
  atualizarFabCalc();
  // só cargas ATIVAS (não finalizadas) entram nos KPIs
  const ativas = state.cargas.filter((c) => c.estado !== "finalizada");
  const comPlano = ativas.filter((c) => c.plano && c.plano.rota_ok);
  $("#kpi-cargas").textContent = ativas.length;
  $("#kpi-km").innerHTML = comPlano.reduce((s, c) => s + c.plano.distancia_total, 0).toFixed(0) + "<small> km</small>";
  // tempo NÃO é somado: mostramos a maior rota (gargalo da operação)
  const maior = comPlano.reduce((m, c) => Math.max(m, c.plano.tempo_min), 0);
  $("#kpi-maxrota").innerHTML = maior + "<small> min</small>";
  $("#kpi-economia").innerHTML = comPlano.reduce((s, c) => s + c.plano.economia, 0).toFixed(0) + "<small> km</small>";
}
function renderDashboard() {
  const calc = state.cargas.filter((c) => c.plano);
  $("#d-cargas").textContent = state.cargas.length;
  $("#d-clientes").textContent = state.cargas.reduce((s, c) => s + c.clientes.length, 0);
  $("#d-distancia").innerHTML = calc.reduce((s, c) => s + c.plano.distancia_total, 0).toFixed(0) + "<small> km</small>";
  $("#d-ocorrencias").textContent = state.ocorrencias.length;
  const bars = $("#chart-bars");
  if (!calc.length) { bars.innerHTML = '<div class="empty" style="margin:auto"><div>Calcule cargas para comparar.</div></div>'; }
  else {
    const dados = calc.slice(0, 6), max = Math.max(...dados.map((c) => c.plano.distancia_total + c.plano.economia), 1);
    bars.innerHTML = dados.map((c) => {
      const otim = c.plano.distancia_total, manual = otim + c.plano.economia;
      const h1 = Math.max(4, (manual / max) * 180), h2 = Math.max(4, (otim / max) * 180);
      return `<div class="bar-col"><div style="display:flex;gap:5px;align-items:flex-end;width:100%;justify-content:center;height:180px"><div class="bar" style="height:0;background:linear-gradient(180deg,#65766d,#3a4640)" data-h="${h1}"></div><div class="bar" style="height:0;background:linear-gradient(180deg,${corDe(c)},${corDe(c)}aa)" data-h="${h2}"></div></div><div class="bar-val">${otim.toFixed(0)}km</div><div class="bar-lbl">${c.id.slice(-3)}</div></div>`;
    }).join("");
    setTimeout(() => bars.querySelectorAll(".bar").forEach((b) => (b.style.height = b.dataset.h + "px")), 60);
  }
  let truck = 0, pickup = 0;
  state.cargas.forEach((c) => (c.veiculo.classe === "truck" ? truck++ : pickup++));
  const total = truck + pickup, pct = total ? (truck / total) * 100 : 0;
  $("#donut-green").setAttribute("stroke-dasharray", `${pct} ${100 - pct}`);
  $("#donut-total").textContent = total; $("#leg-truck").textContent = truck; $("#leg-pickup").textContent = pickup;
}

/* ============ CONFIG ============ */
$("#btn-save-base").addEventListener("click", () => {
  const lat = parseFloat($("#cfg-base-lat").value), lng = parseFloat($("#cfg-base-lng").value);
  if (isNaN(lat) || isNaN(lng)) return toast("Coordenadas da base inválidas.", "err");
  state.base = { nome: $("#cfg-base-nome").value, lat, lng };
  if (map) map.setView([lat, lng], 11);
  renderMapa(); recalcularTodas(); toast("Base atualizada.", "ok");
});
$("#btn-save-fleet").addEventListener("click", () => {
  state.config.limite = +$("#cfg-limite").value || 600;
  state.config.vel_pickup = +$("#cfg-vel-pickup").value || 100;
  state.config.vel_truck = +$("#cfg-vel-truck").value || 70;
  state.config.knn = Math.max(1, +$("#cfg-knn").value || 3);
  state.config.peso_carga = (+$("#cfg-peso-carga").value || 0) / 100;
  state.cargas.forEach((c) => recomputarCarga(c));
  renderCargas(); recalcularTodas(); toast("Parâmetros salvos.", "ok");
});
// rótulo dinâmico do slider da balança
(function () {
  const sl = $("#cfg-peso-carga");
  if (sl) sl.addEventListener("input", () => { const v = $("#cfg-peso-val"); if (v) v.textContent = sl.value + "%"; });
})();

$("#ml-head") && $("#ml-head").addEventListener("click", () => $("#map-legenda").classList.toggle("collapsed"));

/* ============ INICIALIZAÇÃO ============ */
async function init() {
  initMap();
  try {
    state.tipos = await (await fetch("/api/tipos")).json();
    const h = await (await fetch("/api/hoje")).json();
    state.dataHoje = h.data; state.horaHoje = h.hora;
    $("#today-text").innerHTML = `<b>${h.data.split("-").reverse().join("/")}</b>`;
    state.veiculos = await (await fetch("/api/veiculos")).json();
    state.cargas = (await (await fetch("/api/cargas?data=" + state.dataHoje)).json()) || [];
    state.cargas.forEach((c) => { if (!c.cor) c.cor = corDisponivel(); c.clientes.forEach((cl) => { if (cl.id >= _cli) _cli = cl.id + 1; }); });
  } catch (e) { toast("Servidor não respondeu. Rode 'python app.py' e abra http://localhost:5000", "err"); }
  renderOccToolbar(); renderCargas(); renderFrota(); renderRoutePanel(); renderMotorIA(); atualizarKPIs(); renderDashboard(); renderMapa(); initArvore();
  toast("AgroRoute AI pronto. Cadastre a frota e inicie uma carga.", "ok");
}
window.addEventListener("load", init);
