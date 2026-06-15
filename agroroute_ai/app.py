"""
app.py
------
Servidor Flask do AgroRoute AI.

Rotas:
  GET  /                  -> interface (ui/index.html)
  GET  /api/tipos         -> tipos de ocorrência e impactos (fonte única)
  GET  /api/hoje          -> data atual do servidor (ISO) + próximo ID de carga
  GET  /api/cargas?data=  -> lista cargas (filtra por data, se informada)
  POST /api/cargas        -> cria/atualiza uma carga (salva no JSON)
  DELETE /api/cargas/<id> -> remove uma carga
  GET  /api/datas         -> datas com cargas registradas (histórico)
  POST /api/planejar      -> calcula a rota de UMA carga (com retorno à base)

Como executar:
  pip install -r requirements.txt
  python app.py
  abrir http://localhost:5000
"""
import math
import os
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory

from src.planejador import Planejador
from src.roteamento import ServicoRoteamento
from src.clima import ServicoClima
from src.persistencia import Persistencia
from src.ocorrencias import TIPOS

app = Flask(__name__, static_folder="ui", static_url_path="")
banco = Persistencia()

# AGROROUTE_OFFLINE=1 desativa o OSRM (usa linha reta). Útil sem internet.
OFFLINE = os.environ.get("AGROROUTE_OFFLINE", "0") == "1"

# Serviço de roteamento ÚNICO (singleton): mantém o cache de rotas do OSRM entre
# as requisições. Assim, recalcular após uma ocorrência reaproveita as rotas já
# baixadas e só busca o novo desvio -> recálculo em segundos, não minutos.
ROTEAMENTO = ServicoRoteamento(offline=OFFLINE, timeout=5)
CLIMA = ServicoClima(timeout=6)

# Capacidade máxima de carga por viagem (kg). Acima disso o planejamento é
# recusado, orientando dividir a carga ou usar outro caminhão.
LIMITE_CARGA = 12000

# Frota inicial padrão: cadastra uma pickup e um caminhão na primeira execução
# (só se ainda não houver veículos salvos em dados.json).
def _semear_frota():
    if not banco.listar_veiculos():
        banco.salvar_veiculo({"placa": "FGH1I22", "tipo": "Pickup", "estado": "disponível"})
        banco.salvar_veiculo({"placa": "TKC5I67", "tipo": "Caminhão", "estado": "disponível"})


# JSON não aceita Infinity/NaN -> troca por None com segurança
def sanitiza(obj):
    if isinstance(obj, float):
        return None if (math.isinf(obj) or math.isnan(obj)) else obj
    if isinstance(obj, dict):
        return {k: sanitiza(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitiza(v) for v in obj]
    return obj


@app.route("/")
def index():
    return send_from_directory("ui", "index.html")


@app.route("/api/tipos")
def tipos():
    return jsonify(sanitiza(TIPOS))


@app.route("/api/hoje")
def hoje():
    agora = datetime.now()
    data_iso = agora.strftime("%Y-%m-%d")
    return jsonify({
        "data": data_iso,
        "hora": agora.strftime("%H:%M"),
        "proximo_id": banco.proximo_id(data_iso),
    })


@app.route("/api/datas")
def datas():
    return jsonify(banco.datas_disponiveis())


@app.route("/api/cargas", methods=["GET"])
def listar_cargas():
    data = request.args.get("data")
    return jsonify(banco.listar(data))


@app.route("/api/cargas", methods=["POST"])
def salvar_carga():
    carga = request.get_json(force=True)
    carga["ultima_modificacao"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    return jsonify(banco.salvar(carga))


@app.route("/api/cargas/<carga_id>", methods=["DELETE"])
def remover_carga(carga_id):
    banco.remover(carga_id)
    return jsonify({"ok": True})


# ================= FROTA =================
@app.route("/api/veiculos", methods=["GET"])
def listar_veiculos():
    return jsonify(banco.listar_veiculos())


@app.route("/api/veiculos", methods=["POST"])
def salvar_veiculo():
    v = request.get_json(force=True)
    placa = (v.get("placa") or "").strip().upper()
    if not placa:
        return jsonify({"erro": "Informe a placa do veículo."}), 400
    if v.get("tipo") not in ("Pickup", "Caminhão"):
        return jsonify({"erro": "Tipo deve ser Pickup ou Caminhão."}), 400
    veiculo = {"placa": placa, "tipo": v["tipo"], "estado": v.get("estado", "disponível")}
    return jsonify(banco.salvar_veiculo(veiculo))


@app.route("/api/veiculos/<placa>", methods=["DELETE"])
def remover_veiculo(placa):
    banco.remover_veiculo(placa.upper())
    return jsonify({"ok": True})


# ================= CLIMA (chuva real, ao vivo) =================
@app.route("/api/clima", methods=["POST"])
def buscar_clima():
    """Varre a REGIÃO ao redor da base e devolve as zonas com chuva real
    (Open-Meteo, ao vivo) >= 0.8 mm. Cada zona vira uma ocorrência de chuva
    (fonte='clima') com seu raio azul e selo 'AO VIVO'."""
    dados = request.get_json(force=True)
    base = dados.get("base") or {"lat": -18.931325, "lng": -46.971942}
    raio = float(dados.get("raio_km", 100.0))
    passo = float(dados.get("passo_km", 15.0))
    return jsonify(CLIMA.chuva_na_regiao(base["lat"], base["lng"], raio_km=raio, passo_km=passo))


@app.route("/api/planejar", methods=["POST"])
def planejar():
    dados = request.get_json(force=True)
    try:
        clientes = dados.get("clientes") or []
        if not clientes:
            return jsonify({"erro": "Adicione ao menos um cliente."}), 400
        # Guarda de capacidade: não planeja carga acima do limite do caminhão.
        peso_total = sum(float(c.get("peso", 0)) for c in clientes)
        if peso_total > LIMITE_CARGA:
            return jsonify({"erro": f"Carga de {peso_total:.0f} kg excede o limite de "
                                    f"{LIMITE_CARGA} kg. Use outro caminhão ou divida a carga."}), 400
        plan = Planejador(
            dados["base"],
            clientes,
            dados.get("ocorrencias", []),
            dados.get("config", {}),
            roteamento=ROTEAMENTO,
        )
        return jsonify(sanitiza(plan.planejar()))
    except Exception as e:
        return jsonify({"erro": str(e)}), 400


if __name__ == "__main__":
    _semear_frota()
    print("\n  AgroRoute AI  ->  http://localhost:5000\n")
    app.run(debug=False, port=5000)
