"""
roteamento.py
-------------
Classe ServicoRoteamento: obtém o TRAÇADO REAL das estradas entre dois pontos
usando o servidor público OSRM (OpenStreetMap Routing Machine).

- Retorna a distância real (km) e a geometria (lista de [lat, lng]) da estrada.
- Faz cache por par de coordenadas (evita repetir chamadas).
- Se a internet/OSRM estiver indisponível, cai para uma linha reta (fallback),
  para que a aplicação nunca quebre durante uma apresentação.
"""
import math
import requests

OSRM_URL = "https://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}"


class ServicoRoteamento:
    def __init__(self, timeout=6, offline=False):
        self.timeout = timeout
        self.offline = offline          # True força modo linha reta (uso em testes)
        self._cache = {}

    def rota(self, a, b):
        """Retorna dict: {distancia_km, geometria:[[lat,lng]...], real:bool}."""
        chave = tuple(
            sorted(
                [
                    (round(a["lat"], 5), round(a["lng"], 5)),
                    (round(b["lat"], 5), round(b["lng"], 5)),
                ]
            )
        )
        if chave in self._cache:
            return self._cache[chave]

        if self.offline:
            res = self._linha_reta(a, b)
        else:
            res = self._consultar_osrm(a, b)
        self._cache[chave] = res
        return res

    def rota_via(self, a, via, b):
        """Rota A -> VIA -> B numa única chamada ao OSRM, OBRIGANDO a passar pelo
        ponto intermediário `via`. O OSRM "encaixa" o via na estrada mais próxima,
        então isso força um caminho real alternativo (ex.: entrar na cidade por
        outro ponto para contornar um bloqueio). Cai p/ linha reta se offline."""
        if self.offline:
            d1 = self._linha_reta(a, via); d2 = self._linha_reta(via, b)
            return {"distancia_km": d1["distancia_km"] + d2["distancia_km"],
                    "geometria": d1["geometria"] + d2["geometria"][1:], "real": False}
        ck = ("via", round(a["lat"], 5), round(a["lng"], 5), round(via["lat"], 5),
              round(via["lng"], 5), round(b["lat"], 5), round(b["lng"], 5))
        if ck in self._cache:
            return self._cache[ck]
        try:
            url = ("https://router.project-osrm.org/route/v1/driving/"
                   f"{a['lng']},{a['lat']};{via['lng']},{via['lat']};{b['lng']},{b['lat']}")
            resp = requests.get(url, params={"overview": "full", "geometries": "geojson"}, timeout=self.timeout)
            rt = resp.json()["routes"][0]
            geom = [[c[1], c[0]] for c in rt["geometry"]["coordinates"]]
            res = {"distancia_km": rt["distance"] / 1000.0, "geometria": geom, "real": True}
            self._cache[ck] = res
            return res
        except Exception:
            d1 = self._linha_reta(a, via); d2 = self._linha_reta(via, b)
            return {"distancia_km": d1["distancia_km"] + d2["distancia_km"],
                    "geometria": d1["geometria"] + d2["geometria"][1:], "real": False}

    def rotas_alternativas(self, a, b, n=3):
        """Pede ao OSRM VÁRIAS rotas reais entre A e B numa ÚNICA chamada
        (alternatives=true). Retorna lista de {distancia_km, geometria, real}.
        É a forma rápida de achar um desvio: em vez de adivinhar pontos de
        contorno, o próprio OSRM devolve caminhos alternativos de verdade.
        Cai para [linha reta] se estiver offline/sem resposta."""
        if self.offline:
            return [self._linha_reta(a, b)]
        ck = ("alt", tuple(sorted([(round(a["lat"], 5), round(a["lng"], 5)),
                                   (round(b["lat"], 5), round(b["lng"], 5))])))
        if ck in self._cache:
            return self._cache[ck]
        try:
            url = OSRM_URL.format(lng1=a["lng"], lat1=a["lat"], lng2=b["lng"], lat2=b["lat"])
            resp = requests.get(url, params={"overview": "full", "geometries": "geojson",
                                             "alternatives": str(max(1, n))}, timeout=self.timeout)
            rotas = resp.json().get("routes", [])
            saida = []
            for rt in rotas[: n + 1]:
                geom = [[c[1], c[0]] for c in rt["geometry"]["coordinates"]]
                saida.append({"distancia_km": rt["distance"] / 1000.0, "geometria": geom, "real": True})
            if not saida:
                saida = [self._linha_reta(a, b)]
            self._cache[ck] = saida
            return saida
        except Exception:
            return [self._linha_reta(a, b)]

    # ---- chamada real ao OSRM (estradas de verdade) ----
    def _consultar_osrm(self, a, b):
        try:
            url = OSRM_URL.format(lng1=a["lng"], lat1=a["lat"], lng2=b["lng"], lat2=b["lat"])
            resp = requests.get(
                url,
                params={"overview": "full", "geometries": "geojson"},
                timeout=self.timeout,
            )
            rota = resp.json()["routes"][0]
            # OSRM devolve coordenadas como [lng, lat]; convertemos para [lat, lng]
            geometria = [[c[1], c[0]] for c in rota["geometry"]["coordinates"]]
            return {
                "distancia_km": rota["distance"] / 1000.0,
                "geometria": geometria,
                "real": True,
            }
        except Exception:
            return self._linha_reta(a, b)

    # ---- fallback: linha reta (sem internet) ----
    def _linha_reta(self, a, b):
        d = self._haversine(a["lat"], a["lng"], b["lat"], b["lng"])
        return {
            "distancia_km": d,
            "geometria": [[a["lat"], a["lng"]], [b["lat"], b["lng"]]],
            "real": False,
        }

    @staticmethod
    def _haversine(lat1, lng1, lat2, lng2):
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlng = math.radians(lng2 - lng1)
        s = (
            math.sin(dlat / 2) ** 2
            + math.cos(math.radians(lat1))
            * math.cos(math.radians(lat2))
            * math.sin(dlng / 2) ** 2
        )
        return R * 2 * math.atan2(math.sqrt(s), math.sqrt(1 - s))
