"""
lrta.py
-------
========================================================================
  TÉCNICA DE IAC ESCOLHIDA (Aula B, BUSCA ONLINE): LRTA* (Learning
  Real-Time A*). Este arquivo é o NÚCLEO do trabalho, é aqui que a
  inteligência artificial de fato acontece.
========================================================================

Ideia central:
  - O agente NÃO conhece os custos reais das estradas de antemão.
  - A cada passo ele observa apenas os vizinhos do nó atual, escolhe o melhor
    segundo f = custo(atual, vizinho) + H(vizinho) e ATUALIZA a heurística do
    nó atual:  H(atual) = máx(H_antigo, melhor f).
  - Esse "aprendizado" fica salvo na tabela H. Em execuções seguintes (por
    exemplo, após uma ocorrência), o replanejamento é mais rápido e o caminho
    converge para o ótimo.

Esta classe é genérica: recebe o grafo e duas funções (custo real e
heurística), então não depende de como as estradas/ocorrências são calculadas.
"""
INF = float("inf")


class MotorLRTA:
    def __init__(self, grafo, custo_fn, heuristica_fn):
        self.grafo = grafo
        self.custo = custo_fn              # custo(a, b) -> km reais (com ocorrências)
        self.heuristica = heuristica_fn    # h(a, b)     -> km em linha reta
        self.H = {}                        # tabela heurística APRENDIDA
        self.log = []                      # registro de decisões do agente
        self.nos_expandidos = 0
        self.atualizacoes_h = 0
        self.trials = 0
        self.nos_atualizados = set()

    # valor H atual de um nó: o aprendido, ou a heurística inicial
    def get_h(self, nid, objetivo):
        return self.H.get(nid, self.heuristica(nid, objetivo))

    # ---------- UM passo do LRTA* ----------
    def passo(self, atual, objetivo):
        melhor, melhor_f = None, INF
        # 1) avalia cada vizinho: f = custo(atual,viz) + H(viz)
        for v in self.grafo.vizinhos(atual):
            c = self.custo(atual, v)
            if c == INF:                   # trecho bloqueado: ignora
                continue
            f = c + self.get_h(v, objetivo)
            self.nos_expandidos += 1
            if f < melhor_f:
                melhor_f, melhor = f, v
        if melhor is None:                 # sem saída (dead-end)
            return None

        # 2) *** APRENDIZADO HEURÍSTICO (variante MONÓTONA) ***
        #    H(atual) nunca diminui: H = max(H_antigo, melhor_f). Isso garante a
        #    convergência do LRTA* e evita oscilação indefinida entre nós.
        h_antigo = self.get_h(atual, objetivo)
        novo_h = max(h_antigo, melhor_f)
        if novo_h > h_antigo + 1e-9:
            self.atualizacoes_h += 1
            self.nos_atualizados.add(atual)
            self.log.append({"t": "upd", "no": atual, "de": h_antigo, "para": novo_h})
        self.H[atual] = novo_h

        # 3) move para o melhor vizinho
        self.log.append({"t": "move", "de": atual, "para": melhor,
                         "custo": self.custo(atual, melhor)})
        return melhor

    # ---------- busca completa (várias tentativas até convergir) ----------
    def buscar(self, inicio, objetivo):
        MAX_TRIALS = 6
        # limite generoso: o LRTA* sempre chega ao objetivo em grafo finito com
        # custos positivos; numa malha densa pode precisar de muitos passos.
        MAX_PASSOS = max(800, self.grafo.num_nos() ** 2)
        melhor_caminho, melhor_custo = None, INF

        for _ in range(MAX_TRIALS):
            self.trials += 1
            atual = inicio
            caminho = [atual]
            custo_total = 0.0
            passos = 0
            houve_update = False

            while atual != objetivo and passos < MAX_PASSOS:
                antes = self.atualizacoes_h
                prox = self.passo(atual, objetivo)
                if prox is None:
                    break                  # preso: encerra esta tentativa
                if self.atualizacoes_h > antes:
                    houve_update = True
                custo_total += self.custo(atual, prox)
                atual = prox
                caminho.append(atual)
                passos += 1

            if atual == objetivo:
                if custo_total < melhor_custo:
                    melhor_custo, melhor_caminho = custo_total, caminho
                # convergiu: tentativa sem nenhuma atualização de H
                if not houve_update:
                    break

        if melhor_caminho:
            return {"caminho": melhor_caminho, "custo": melhor_custo}
        return {"caminho": None, "custo": INF}   # nenhuma rota possível
