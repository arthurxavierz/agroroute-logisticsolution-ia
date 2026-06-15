"""
persistencia.py
---------------
Classe Persistencia: guarda CARGAS e a FROTA em um arquivo JSON local
(dados.json), sem precisar de banco de dados.

- Cargas guardam a DATA de criação -> filtro por dia / histórico retroativo.
- Frota guarda placa, tipo (pickup/caminhão) e estado (disponível/em rota).
"""
import json
import os

ARQUIVO_PADRAO = "dados.json"


class Persistencia:
    def __init__(self, caminho=ARQUIVO_PADRAO):
        self.caminho = caminho

    # ---- arquivo inteiro ----
    def _ler(self):
        if not os.path.exists(self.caminho):
            return {"cargas": [], "veiculos": []}
        try:
            with open(self.caminho, encoding="utf-8") as f:
                d = json.load(f)
                d.setdefault("cargas", [])
                d.setdefault("veiculos", [])
                return d
        except Exception:
            return {"cargas": [], "veiculos": []}

    def _gravar(self, dados):
        with open(self.caminho, "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False, indent=2)

    # ================= CARGAS =================
    def listar(self, data=None):
        cargas = self._ler()["cargas"]
        if data:
            cargas = [c for c in cargas if c.get("data_criacao") == data]
        return sorted(cargas, key=lambda c: c.get("ultima_modificacao", ""), reverse=True)

    def salvar(self, carga):
        dados = self._ler()
        idx = next((i for i, c in enumerate(dados["cargas"]) if c["id"] == carga["id"]), None)
        if idx is None:
            dados["cargas"].append(carga)
        else:
            dados["cargas"][idx] = carga
        self._gravar(dados)
        return carga

    def remover(self, carga_id):
        dados = self._ler()
        dados["cargas"] = [c for c in dados["cargas"] if c["id"] != carga_id]
        self._gravar(dados)

    def datas_disponiveis(self):
        datas = {c.get("data_criacao") for c in self._ler()["cargas"] if c.get("data_criacao")}
        return sorted(datas, reverse=True)

    def proximo_id(self, data_iso):
        compacto = data_iso.replace("-", "")
        existentes = {c["id"] for c in self._ler()["cargas"]}
        n = 1
        while f"CRG-{compacto}-{n:03d}" in existentes:
            n += 1
        return f"CRG-{compacto}-{n:03d}"

    # ================= FROTA =================
    def listar_veiculos(self):
        return self._ler()["veiculos"]

    def salvar_veiculo(self, veiculo):
        dados = self._ler()
        idx = next((i for i, v in enumerate(dados["veiculos"]) if v["placa"] == veiculo["placa"]), None)
        if idx is None:
            dados["veiculos"].append(veiculo)
        else:
            dados["veiculos"][idx] = veiculo
        self._gravar(dados)
        return veiculo

    def remover_veiculo(self, placa):
        dados = self._ler()
        dados["veiculos"] = [v for v in dados["veiculos"] if v["placa"] != placa]
        self._gravar(dados)
