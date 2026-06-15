"""
clima.py
--------
ServicoClima: consulta precipitação REAL em tempo real pela API Open-Meteo
(gratuita, sem chave). Usado para criar ocorrências de chuva "ao vivo" apenas
nas coordenadas das ENTREGAS (não no mapa todo).

Open-Meteo devolve a precipitação atual (mm) por coordenada. Classificamos em:
  - 0.8 a 1.0 mm  -> fraca   (penaliza pouco o tempo)
  - 1.0 a 1.6 mm  -> media
  - > 1.6 mm      -> forte   (penaliza bastante o tempo)
Abaixo de 0.8 mm não vira ocorrência.
"""
import requests
import math

LIMIAR_MM = 0.8
API = "https://api.open-meteo.com/v1/forecast"

# faixa -> (rótulo, multiplicador de TEMPO)
def classificar(mm):
    if mm < LIMIAR_MM:
        return None
    if mm < 1.0:
        return {"intensidade": "fraca", "mult": 1.15}
    if mm < 1.6:
        return {"intensidade": "media", "mult": 1.35}
    return {"intensidade": "forte", "mult": 1.6}


class ServicoClima:
    def __init__(self, timeout=6):
        self.timeout = timeout

    def precipitacao(self, lat, lng):
        """Precipitação atual (mm) na coordenada. None se a API falhar."""
        try:
            r = requests.get(API, params={
                "latitude": lat, "longitude": lng,
                "current": "precipitation,rain,weather_code",
                "timezone": "auto",
            }, timeout=self.timeout)
            cur = r.json().get("current", {})
            # 'precipitation' já soma chuva+pancadas; usa rain como reforço
            mm = cur.get("precipitation")
            if mm is None:
                mm = cur.get("rain", 0.0)
            return float(mm or 0.0)
        except Exception:
            return None

    def chuva_na_regiao(self, centro_lat, centro_lng, raio_km=100.0, passo_km=15.0):
        """Varre uma GRADE quadrada (~raio_km de raio, pontos a cada ~passo_km) ao
        redor de um centro e devolve as zonas com chuva relevante (>= limiar),
        cada uma classificada por intensidade. Consultas em paralelo. Usado para
        'achar onde está chovendo agora' na região e cadastrar a entrega lá."""
        from concurrent.futures import ThreadPoolExecutor
        km = 111.0
        coslat = max(0.2, math.cos(math.radians(centro_lat)))
        n = int(raio_km / passo_km)
        pontos = []
        for i in range(-n, n + 1):
            for j in range(-n, n + 1):
                if (i * passo_km) ** 2 + (j * passo_km) ** 2 <= raio_km ** 2:
                    pontos.append((centro_lat + i * passo_km / km, centro_lng + j * passo_km / (km * coslat)))

        # consulta TODOS os pontos em poucas requisições (bulk)
        mms = self.precipitacao_bulk(pontos)

        ocorrencias, erros, consultados = [], 0, 0
        for pt, mm in zip(pontos, mms):
            if mm is None:
                erros += 1
                continue
            consultados += 1
            cls = classificar(mm)
            if cls:
                ocorrencias.append({
                    "tipo": "chuva", "forma": "ponto", "lat": round(pt[0], 5), "lng": round(pt[1], 5),
                    "fonte": "clima", "mm": round(mm, 2),
                    "intensidade": cls["intensidade"], "mult": cls["mult"], "ref": "região",
                })
        return {"ocorrencias": ocorrencias, "erro": erros > 0 and consultados == 0,
                "consultados": consultados, "total_pontos": len(pontos)}

    def precipitacao_bulk(self, coords):
        """Consulta VÁRIAS coordenadas numa única requisição (a Open-Meteo aceita
        listas lat/lng separadas por vírgula). Devolve lista de mm na mesma ordem
        (None onde falhar). Quebra em blocos para não estourar a URL."""
        saida = [None] * len(coords)
        BLOCO = 90
        for ini in range(0, len(coords), BLOCO):
            sub = coords[ini:ini + BLOCO]
            lats = ",".join(f"{c[0]:.4f}" for c in sub)
            lngs = ",".join(f"{c[1]:.4f}" for c in sub)
            try:
                r = requests.get(API, params={"latitude": lats, "longitude": lngs,
                                              "current": "precipitation", "timezone": "auto"},
                                 timeout=self.timeout)
                js = r.json()
                # resposta pode ser lista (multi) ou objeto único (1 ponto)
                blocos = js if isinstance(js, list) else [js]
                for k, b in enumerate(blocos):
                    cur = b.get("current", {}) if isinstance(b, dict) else {}
                    mm = cur.get("precipitation")
                    saida[ini + k] = float(mm) if mm is not None else 0.0
            except Exception:
                pass  # deixa None nesse bloco
        return saida

    def chuva_nos_pontos(self, pontos):
        """Recebe lista de {id,nome,lat,lng}; consulta cada um EM PARALELO.
        Devolve lista de ocorrências de chuva real (forma 'ponto', raio 10 km)
        só onde a precipitação >= limiar, já classificada por intensidade."""
        from concurrent.futures import ThreadPoolExecutor
        def consultar(p):
            mm = self.precipitacao(p["lat"], p["lng"])
            if mm is None:
                return ("erro", p, None)
            cls = classificar(mm)
            if not cls:
                return ("seco", p, mm)
            return ("chuva", p, {"mm": round(mm, 2), **cls})
        with ThreadPoolExecutor(max_workers=min(8, max(1, len(pontos)))) as ex:
            resultados = list(ex.map(consultar, pontos))
        ocorrencias, houve_erro, consultados = [], False, 0
        for status, p, info in resultados:
            if status == "erro":
                houve_erro = True
                continue
            consultados += 1
            if status == "chuva":
                ocorrencias.append({
                    "tipo": "chuva", "forma": "ponto", "lat": p["lat"], "lng": p["lng"],
                    "fonte": "clima",  # marca como REAL (ao vivo)
                    "mm": info["mm"], "intensidade": info["intensidade"], "mult": info["mult"],
                    "ref": p.get("nome", ""),
                })
        return {"ocorrencias": ocorrencias, "erro": houve_erro, "consultados": consultados}
