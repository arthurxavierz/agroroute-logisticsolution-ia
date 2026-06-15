"""
ocorrencias.py
--------------
Tipos de ocorrência + GerenciadorOcorrencias.

DOIS COMPORTAMENTOS distintos (como no trânsito real / Waze):

  (A) SÓ PENALIZA O TEMPO  -> efeito 'tempo'
      - Chuva intensa (raio 10 km): a estrada continua passável, mas mais lenta.
        Aumenta o custo/tempo, sem obrigar desvio.

  (B) BLOQUEIO TOTAL  -> efeito 'bloqueio'  (custo INFINITO)
      - Acidente / Ponte / Obra: raio pequeno (500 m).
      - Siga e Pare / Estrada interditada: TRECHO selecionado (2 cliques).
      A IA é obrigada a achar OUTRO caminho real, mesmo que pior.

Formato espacial:
  - 'ponto'  : afeta tudo dentro de um RAIO (km) do clique.
  - 'trecho' : afeta a faixa (buffer km) ao longo de um segmento (2 cliques).
"""
import math

INF = float("inf")

# efeito: 'tempo' (encarece) | 'bloqueio' (intransitável)
TIPOS = {
    "chuva":    {"nome": "Chuva intensa",       "efeito": "tempo",    "forma": "ponto",  "raio_km": 10.0, "mult": 1.3, "cor": "#38bdf8", "desc": "Pista mais lenta (raio 10 km)"},
    "acidente": {"nome": "Acidente",            "efeito": "bloqueio", "forma": "ponto",  "raio_km": 0.5,  "mult": INF, "cor": "#f43f5e", "desc": "Bloqueio total (raio 500 m)"},
    "ponte":    {"nome": "Ponte interditada",   "efeito": "bloqueio", "forma": "ponto",  "raio_km": 0.5,  "mult": INF, "cor": "#b91c1c", "desc": "Bloqueio total (raio 500 m)"},
    "obra":     {"nome": "Obra",                "efeito": "bloqueio", "forma": "ponto",  "raio_km": 0.5,  "mult": INF, "cor": "#f59e0b", "desc": "Bloqueio total (raio 500 m)"},
    "sigapare": {"nome": "Siga e Pare",         "efeito": "bloqueio", "forma": "trecho", "buffer_km": 0.8, "mult": INF, "cor": "#fb923c", "desc": "Trecho intransitável (desvio)"},
    "estrada":  {"nome": "Estrada interditada", "efeito": "bloqueio", "forma": "trecho", "buffer_km": 0.8, "mult": INF, "cor": "#7f1d1d", "desc": "Trecho interditado (desvio)"},
}


class GerenciadorOcorrencias:
    def __init__(self, ocorrencias):
        self.ocorrencias = ocorrencias or []

    def tem_bloqueio(self, geometria):
        """True se algum BLOQUEIO (acidente/ponte/obra/siga-e-pare/estrada) toca
        o traçado. Usado no ROTEAMENTO (bloqueio muda a rota; chuva não)."""
        for oc in self.ocorrencias:
            tipo = TIPOS.get(oc["tipo"])
            if tipo and tipo["efeito"] == "bloqueio" and self._afeta(oc, tipo, geometria):
                return True
        return False

    def fator_tempo(self, geometria):
        """Fator de TEMPO da chuva, PROPORCIONAL à parte do trecho dentro da chuva.
        O trecho é dividido em pontos finos (~0.2 km); para cada ponto vemos quais
        chuvas o cobrem e seu multiplicador, e tiramos a MÉDIA ponto a ponto. Assim,
        se só uma pontinha do trecho está na chuva, só ela é penalizada.
        (Não afeta a distância, só o tempo.)"""
        chuvas = [oc for oc in self.ocorrencias
                  if TIPOS.get(oc["tipo"]) and TIPOS[oc["tipo"]]["efeito"] == "tempo"]
        if not chuvas:
            return 1.0
        pts = self._densificar(geometria, passo_km=0.2)
        if not pts:
            return 1.0
        soma = 0.0
        for p in pts:
            m_ponto = 1.0
            for oc in chuvas:                      # um ponto pode estar em +de 1 chuva
                tipo = TIPOS[oc["tipo"]]
                if self._haversine(p[0], p[1], oc["lat"], oc["lng"]) <= tipo["raio_km"]:
                    m_ponto *= oc.get("mult", tipo["mult"])
            soma += m_ponto
        return soma / len(pts)                      # média ponderada (proporcional)

    def multiplicador(self, geometria):
        """Compatibilidade: INF se houver bloqueio; senão o fator de tempo da chuva."""
        if self.tem_bloqueio(geometria):
            return INF
        return self.fator_tempo(geometria)

    # ---- a ocorrência atinge o traçado deste trecho? ----
    def _afeta(self, oc, tipo, geometria):
        pts = self._densificar(geometria, passo_km=0.2)   # robusto p/ raio pequeno
        if tipo["forma"] == "ponto":
            raio = tipo["raio_km"]
            return any(self._haversine(p[0], p[1], oc["lat"], oc["lng"]) <= raio for p in pts)
        else:
            buf = tipo["buffer_km"]
            (alat, alng), (blat, blng) = oc["pontos"][0], oc["pontos"][1]
            return any(self._dist_ponto_segmento(p[0], p[1], alat, alng, blat, blng) <= buf for p in pts)

    # interpola pontos ao longo da polilinha (passo fino p/ detectar raios de 500 m)
    def _densificar(self, geometria, passo_km=0.2):
        if not geometria:
            return []
        if len(geometria) == 1:
            return list(geometria)
        saida = []
        for i in range(len(geometria) - 1):
            a, b = geometria[i], geometria[i + 1]
            d = self._haversine(a[0], a[1], b[0], b[1])
            n = max(1, int(d / passo_km))
            for k in range(n):
                t = k / n
                saida.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        saida.append(geometria[-1])
        return saida

    @staticmethod
    def _haversine(lat1, lng1, lat2, lng2):
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlng = math.radians(lng2 - lng1)
        s = (math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
        return R * 2 * math.atan2(math.sqrt(s), math.sqrt(1 - s))

    def _dist_ponto_segmento(self, plat, plng, alat, alng, blat, blng):
        latm = math.radians((alat + blat) / 2)
        kx = 111.32 * math.cos(latm); ky = 110.57
        px, py = plng * kx, plat * ky
        ax, ay = alng * kx, alat * ky
        bx, by = blng * kx, blat * ky
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return math.hypot(px - ax, py - ay)
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))
