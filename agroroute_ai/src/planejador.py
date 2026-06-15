"""
planejador.py
-------------
Orquestra UMA carga (uma viagem): monta o problema, roda o LRTA* e devolve a
rota pronta para o mapa, junto com as métricas.

COMO FUNCIONA (visão geral):
  1) Os pontos principais são a base e as fazendas da carga. As distâncias reais
     entre eles vêm do OSRM (estradas de verdade) e ficam em cache.
  2) A ORDEM de visita é decidida pela balança distância x peso (ver planejar()).
  3) Cada trecho da rota é resolvido em _resolver_trecho():
        - se está livre, usa a rota direta (a chuva penaliza só o tempo);
        - se um BLOQUEIO o atinge (custo infinito), _contornar() gera um desvio
          real por estradas vizinhas, ao redor do obstáculo.
  4) O LRTA* (lrta.py) também é executado de fato (motor.buscar), produzindo as
     métricas e o log de aprendizado mostrados na aba "Motor de Busca Online".

A rota final é o ciclo  Base -> entregas... -> Base.
"""
import math
from .roteamento import ServicoRoteamento
from .ocorrencias import GerenciadorOcorrencias, TIPOS
from .lrta import MotorLRTA

INF = float("inf")


def _fatorial(n):
    f = 1
    for i in range(2, n + 1):
        f *= i
    return f


class Planejador:
    def __init__(self, base, clientes, ocorrencias, config, roteamento=None):
        self.base = base
        self.clientes = clientes
        self.config = config or {}
        self.roteamento = roteamento or ServicoRoteamento()
        self.occ = GerenciadorOcorrencias(ocorrencias)

        self.principais = [{"id": "base", "nome": base["nome"], "lat": base["lat"], "lng": base["lng"]}]
        for c in clientes:
            self.principais.append({"id": "c" + str(c["id"]), "nome": c.get("fazenda") or c["nome"], "lat": c["lat"], "lng": c["lng"]})

        self._coords = {}     # id -> (lat,lng)
        self._seg = {}        # key(coord,coord) -> {distancia_km, geometria, real}
        self.adj = {}         # malha
        self._corredor = {}   # id do nó -> índice do corredor (para desvios)
        for n in self.principais:
            self._coords[n["id"]] = (n["lat"], n["lng"])
            self.adj[n["id"]] = set()

        self._construir_malha()

    # =============== grafo do LRTA* (leve e rápido) ===============
    def _construir_malha(self):
        """Grafo COMPLETO apenas entre os pontos principais (base + fazendas).
        É pequeno (poucos nós) -> o LRTA* converge rápido e roda em milissegundos.
        As rotas reais e os DESVIOS de bloqueio são resolvidos sob demanda em
        _resolver_trecho (rota direta do OSRM; se bloqueada, alternativas do OSRM).
        Nada de pré-cachear dezenas de arestas, era isso que deixava lento."""
        ids = [n["id"] for n in self.principais]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                self._ligar(ids[i], ids[j])
                self._corredor.setdefault(ids[i], -1); self._corredor.setdefault(ids[j], -1)

        # PRÉ-CARREGA todas as rotas diretas entre principais EM PARALELO (I/O).
        # Assim o 1º cálculo não fica esperando dezenas de chamadas em sequência;
        # o que já estiver no cache (singleton) é reaproveitado de imediato.
        pares = [(ids[i], ids[j]) for i in range(len(ids)) for j in range(i + 1, len(ids))]
        faltam = [(a, b) for (a, b) in pares if self._key(self._coords[a], self._coords[b]) not in self._seg]
        if faltam:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=min(8, len(faltam))) as ex:
                list(ex.map(lambda ab: self._osrm(self._coords[ab[0]], self._coords[ab[1]]), faltam))

    def _ligar(self, a, b):
        if a != b:
            self.adj.setdefault(a, set()).add(b)
            self.adj.setdefault(b, set()).add(a)

    # =============== rotas reais ===============
    def _osrm(self, ca, cb):
        key = self._key(ca, cb)
        if key not in self._seg:
            self._seg[key] = self.roteamento.rota({"lat": ca[0], "lng": ca[1]}, {"lat": cb[0], "lng": cb[1]})
        return self._orientar(self._seg[key], ca)

    def _store_seg(self, ca, cb, geom, dist, real):
        self._seg[self._key(ca, cb)] = {"distancia_km": dist, "geometria": geom, "real": real}

    def _rota(self, a, b):
        return self._osrm(self._coords[a], self._coords[b])

    def _orientar(self, r, ca):
        geom = r["geometria"]
        if geom:
            if abs(geom[0][0] - ca[0]) + abs(geom[0][1] - ca[1]) > abs(geom[-1][0] - ca[0]) + abs(geom[-1][1] - ca[1]):
                geom = list(reversed(geom))
        return {"distancia_km": r["distancia_km"], "geometria": geom, "real": r["real"]}

    @staticmethod
    def _key(ca, cb):
        return tuple(sorted([(round(ca[0], 5), round(ca[1], 5)), (round(cb[0], 5), round(cb[1], 5))]))

    # =============== custo e heurística usados pelo LRTA* ===============
    # Estas DUAS funções são o que o motor LRTA* recebe (ver lrta.py). Elas
    # traduzem "o mundo real" (estradas + ocorrências) para o algoritmo.

    def custo(self, a, b):
        """Custo REAL de ir de a até b, em km, do ponto de vista do ROTEAMENTO.
        Regra central: se houver um BLOQUEIO no trecho, o custo é INFINITO
        (o LRTA* então descarta esse caminho). A CHUVA não entra aqui de
        propósito: ela penaliza só o TEMPO, nunca a escolha da rota."""
        ck = self._key(self._coords[a], self._coords[b])
        if not hasattr(self, "_blqcache"):
            self._blqcache = {}            # memoriza bloqueio por trecho (rápido)
        r = self._rota(a, b)
        if ck in self._blqcache:
            bloq = self._blqcache[ck]
        else:
            bloq = self.occ.tem_bloqueio(r["geometria"])
            self._blqcache[ck] = bloq
        return INF if bloq else max(r["distancia_km"], 0.05)

    def heuristica(self, a, b):
        """Heurística H: distância em LINHA RETA (Haversine) entre dois pontos.
        É o "palpite" otimista que o LRTA* usa e vai corrigindo conforme aprende."""
        (la, ga), (lb, gb) = self._coords[a], self._coords[b]
        return self._haversine(la, ga, lb, gb)

    def vizinhos(self, nid):
        # nós alcançáveis a partir de nid (o LRTA* só "enxerga" os vizinhos)
        return list(self.adj.get(nid, set()))

    def num_nos(self):
        return len(self._coords)

    def _veiculo(self, peso):
        if peso <= self.config.get("limite", 600):
            return {"tipo": "Pickup", "vel": self.config.get("vel_pickup", 100), "classe": "pickup"}
        return {"tipo": "Caminhão", "vel": self.config.get("vel_truck", 70), "classe": "truck"}

    # =============== DESVIO REAL via OSRM (pontos de fuga) ===============
    def _geometria_bloqueada(self, geom):
        """True se a geometria passa por dentro de alguma ocorrência de BLOQUEIO."""
        return self.occ.tem_bloqueio(geom)

    def _centros_bloqueio(self, geom):
        """Centros das ocorrências de BLOQUEIO que realmente atingem esta rota."""
        centros = []
        for oc in self.occ.ocorrencias:
            tipo = TIPOS.get(oc["tipo"])
            if not tipo or tipo["efeito"] != "bloqueio":
                continue
            if self.occ._afeta(oc, tipo, geom):
                if oc.get("forma") == "ponto":
                    centros.append((oc["lat"], oc["lng"]))
                else:
                    (p1, p2) = oc["pontos"]
                    centros.append(((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2))
        return centros

    def _contornar(self, a, b):
        """Acha uma ROTA DE CONTORNO real ao redor do bloqueio.

        A ideia-chave: gerar pontos de desvio EM VOLTA DO PRÓPRIO BLOQUEIO, em
        raios pequenos (1.5 a 12 km) e em várias direções. O OSRM 'encaixa' cada
        ponto na estrada mais próxima e é OBRIGADO a passar por ele (rota_via),
        produzindo um caminho real que entra/sai por outro ponto, exatamente como
        um GPS faz para contornar um obstáculo. Para no menor raio que funciona
        (desvio mais natural). Retorna None só se nada evitar o bloqueio."""
        ca, cb = self._coords[a], self._coords[b]
        pa = {"lat": ca[0], "lng": ca[1]}; pb = {"lat": cb[0], "lng": cb[1]}

        direta = self._osrm(ca, cb)
        centros = self._centros_bloqueio(direta["geometria"])
        if not centros:   # nada bloqueia de fato -> rota direta serve
            return {"distancia_km": direta["distancia_km"], "geometria": direta["geometria"], "real": direta["real"]}

        # (1) alternativas nativas do OSRM (1 chamada), às vezes já resolve
        for alt in self.roteamento.rotas_alternativas(pa, pb, n=3):
            if alt["geometria"] and not self._geometria_bloqueada(alt["geometria"]):
                return {"distancia_km": alt["distancia_km"], "geometria": alt["geometria"], "real": alt["real"]}

        # (2) pontos de desvio AO REDOR do bloqueio (raios crescentes).
        #     As 8 direções de cada raio são consultadas EM PARALELO (I/O), então
        #     um anel inteiro custa ~1 ida-e-volta de rede em vez de 8.
        from concurrent.futures import ThreadPoolExecutor
        km = 111.0
        melhor = None
        for (clat, clng) in centros:
            coslat = max(0.2, math.cos(math.radians(clat)))
            for raio in (1.5, 3.0, 6.0, 12.0, 20.0):
                vias = []
                for ang in range(0, 360, 45):   # 8 direções
                    rad = math.radians(ang)
                    vlat = clat + (raio / km) * math.cos(rad)
                    vlng = clng + (raio / (km * coslat)) * math.sin(rad)
                    vias.append({"lat": vlat, "lng": vlng})
                with ThreadPoolExecutor(max_workers=8) as ex:
                    resultados = list(ex.map(lambda v: self.roteamento.rota_via(pa, v, pb), vias))
                achou_no_raio = None
                for via in resultados:
                    if not via["geometria"] or self._geometria_bloqueada(via["geometria"]):
                        continue
                    if achou_no_raio is None or via["distancia_km"] < achou_no_raio["distancia_km"]:
                        achou_no_raio = {"distancia_km": via["distancia_km"], "geometria": via["geometria"], "real": via["real"]}
                if achou_no_raio:
                    melhor = achou_no_raio
                    break   # menor raio que funciona = desvio mais curto/natural
            if melhor:
                break
        return melhor

    def _resolver_trecho(self, a, b):
        """Resolve UM trecho A->B respeitando bloqueios.
        Retorna {geometria, distancia_km, tempo_fator, via} ou None se inacessível.
          - tempo_fator > 1 (ex.: chuva) penaliza só o TEMPO, não a distância.
          - bloqueio (custo infinito) -> gera contorno real via OSRM."""
        r = self._osrm(self._coords[a], self._coords[b])
        if r["geometria"] and not self.occ.tem_bloqueio(r["geometria"]):
            # livre (talvez com chuva, que pesa só o tempo, de forma proporcional)
            fator = self.occ.fator_tempo(r["geometria"])
            return {"geometria": r["geometria"], "distancia_km": r["distancia_km"], "tempo_fator": fator, "via": "direta"}
        # bloqueado -> contorno real (pontos de fuga)
        cont = self._contornar(a, b)
        if cont:
            fator = self.occ.fator_tempo(cont["geometria"])
            return {"geometria": cont["geometria"], "distancia_km": cont["distancia_km"], "tempo_fator": fator, "via": "contorno"}
        return None

    # =============== PLANEJAMENTO (monta a rota completa de uma carga) ===============
    def planejar(self):
        # adapta este planejador para a interface que o LRTA* espera (grafo)
        grafo = _GrafoAdapter(self)
        motor = MotorLRTA(grafo, self.custo, self.heuristica)
        peso_total = sum(c["peso"] for c in self.clientes)
        veiculo = self._veiculo(peso_total)   # pickup ou caminhão, pelo peso

        # ORDEM DE ENTREGAS: balança DISTÂNCIA x PESO.
        # Critério: chave(p) = distancia(atual,p) / (peso_p ^ beta)
        #   - beta = 0  -> só distância (vizinho mais próximo, comportamento antigo);
        #   - beta > 0  -> clientes PESADOS ficam mais "atraentes" para ir primeiro,
        #                  evitando arrastar carga pesada em desvios (ton-quilômetro).
        #   - quando os pesos são parecidos, o peso some da conta e vale a distância.
        # Ex.: Patos 7000 kg vs. um desvio de 300 kg -> entrega Patos primeiro.
        beta = float(self.config.get("peso_carga", 0.7))

        pendentes = set("c" + str(c["id"]) for c in self.clientes)
        peso_de = {"c" + str(c["id"]): max(1.0, float(c["peso"])) for c in self.clientes}
        atual, ordem = "base", []
        while pendentes:
            def chave(p):
                d = self.custo(atual, p)
                if d == INF:
                    return self.heuristica(atual, p) * 1e6   # bloqueado: evita
                return d / (peso_de[p] ** beta)
            prox = min(pendentes, key=chave)
            ordem.append(prox); pendentes.discard(prox); atual = prox

        sequencia = ["base"] + ordem + ["base"]
        trechos, dist_total, tempo_acc, rota_ok = [], 0.0, 0.0, True
        inacessiveis = []
        for i in range(len(sequencia) - 1):
            origem, destino = sequencia[i], sequencia[i + 1]
            eh_retorno = (i == len(sequencia) - 2)
            sol = self._resolver_trecho(origem, destino)
            if sol is None:
                rota_ok = False
                if destino != "base":
                    inacessiveis.append(destino)
                # mantém a geometria original (bloqueada) p/ a interface desenhar
                # tracejada em vermelho, em vez de apagar a rota.
                dir_bloq = self._osrm(self._coords[origem], self._coords[destino])
                trechos.append({"origem": origem, "destino": destino, "bloqueado": True,
                                "retorno": eh_retorno, "geometria": dir_bloq["geometria"]})
            else:
                motor.buscar(origem, destino)   # roda o LRTA* p/ métricas/log reais
                dist_total += sol["distancia_km"]
                tempo_acc += sol["distancia_km"] / veiculo["vel"] * 60 * sol["tempo_fator"]
                trechos.append({"origem": origem, "destino": destino, "custo": round(sol["distancia_km"], 2),
                                "retorno": eh_retorno, "via": sol.get("via", "direta"),
                                "tempo_fator": round(sol["tempo_fator"], 2), "geometria": sol["geometria"]})

        # ECONOMIA (opção B): compara a rota otimizada com a MÉDIA de ordens
        # aleatórias de visita. Usa a DISTÂNCIA DIRETA (cache) de cada trecho -
        # NÃO recalcula contornos aqui (a economia é só uma referência, e refazer
        # o desvio em 24 permutações deixava o recálculo lento).
        if rota_ok and len(self.clientes) >= 2:
            import random as _rnd
            ids_cli = ["c" + str(c["id"]) for c in self.clientes]
            amostras, n_amostras = [], min(24, _fatorial(len(ids_cli)))
            _rnd.seed(42)  # determinístico (mesma carga -> mesma economia)
            for _ in range(n_amostras):
                perm = ids_cli[:]; _rnd.shuffle(perm)
                seq = ["base"] + perm + ["base"]
                d = sum(self._osrm(self._coords[seq[k]], self._coords[seq[k + 1]])["distancia_km"]
                        for k in range(len(seq) - 1))
                amostras.append(d)
            media_aleatoria = sum(amostras) / len(amostras)
            economia = max(0.0, media_aleatoria - dist_total)
            baseline = round(media_aleatoria, 2)
        else:
            economia = 0.0
            baseline = round(dist_total, 2)
        tempo_min = round(tempo_acc)

        # nomes legíveis dos clientes inacessíveis (p/ aviso na interface)
        nome_por_id = {n["id"]: n["nome"] for n in self.principais}
        inacessiveis_nomes = [nome_por_id.get(x, x) for x in inacessiveis]

        nos_ui = self.principais
        idset = {n["id"] for n in nos_ui}
        # percentual de economia (p/ exibir "X% menor que uma ordem qualquer")
        econ_pct = round(economia / baseline * 100, 1) if baseline else 0.0
        return {
            "ordem": ordem, "trechos": trechos,
            "distancia_total": round(dist_total, 2), "baseline": round(baseline, 2),
            "economia": round(economia, 2), "economia_pct": econ_pct, "peso_total": peso_total,
            "veiculo": veiculo, "tempo_min": tempo_min, "rota_ok": rota_ok,
            "inacessiveis": inacessiveis_nomes,
            "nos": nos_ui, "rotas_reais": any(v["real"] for v in self._seg.values()),
            "lrta": {
                "H": {k: round(v, 2) for k, v in motor.H.items() if k in idset},
                "h_inicial": {n["id"]: round(self.heuristica(n["id"], "base"), 2) for n in nos_ui},
                "log": [l for l in motor.log if self._log_principal(l, idset)][-60:],
                "trials": motor.trials, "nos_expandidos": motor.nos_expandidos,
                "atualizacoes_h": motor.atualizacoes_h,
                "nos_atualizados": [x for x in motor.nos_atualizados if x in idset],
                "objetivo": "base", "total_nos_malha": self.num_nos(),
            },
        }

    def _log_principal(self, l, idset):
        if l["t"] == "move":
            return l["de"] in idset or l["para"] in idset
        return l.get("no") in idset

    @staticmethod
    def _haversine(lat1, lng1, lat2, lng2):
        R = 6371.0
        dlat = math.radians(lat2 - lat1); dlng = math.radians(lng2 - lng1)
        s = (math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
        return R * 2 * math.atan2(math.sqrt(s), math.sqrt(1 - s))

class _GrafoAdapter:
    def __init__(self, plan): self.plan = plan
    def num_nos(self): return self.plan.num_nos()
    def vizinhos(self, nid): return self.plan.vizinhos(nid)
    def distancia_geo(self, a, b): return self.plan.heuristica(a, b)
