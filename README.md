# AgroRoute AI

**Planejamento dinâmico de rotas em tempo real para revendas agrícolas com LRTA\***!

Plataforma web que planeja e **replaneja** rotas de entrega de insumos agrícolas usando
**Busca Online (LRTA\*)**: um agente que decide o próximo passo com o que observa, aprende
com a estrada e recalcula quando o caminho muda (bloqueios, chuva). As rotas seguem
**estradas reais** (OpenStreetMap via OSRM) e o clima é consultado **ao vivo** (Open-Meteo).

> Trabalho da disciplina **Inteligência Artificial e Computacional** (IFTM Campus Patrocínio).
> Técnica IAC: Busca Online (LRTA\*)**.

<img width="1852" height="902" alt="image" src="https://github.com/user-attachments/assets/f8ec48ed-e96d-429e-a3ab-1912a78eaef6" />

---

## Sumário

- [Principais recursos](#principais-recursos)
- [Como executar](#como-executar)
- [Como usar](#como-usar)
- [A técnica de IA (LRTA\*)](#a-técnica-de-ia-lrta)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Tecnologias](#tecnologias)

---

## Principais recursos

- **Roteirização por estradas reais** (OSRM) com retorno à base no fim do ciclo.
- **Replanejamento dinâmico:** ao registrar um bloqueio, a IA contorna o obstáculo por
  estradas vizinhas; se não houver saída, avisa sem inflar os números.
- **Clima ao vivo (Open-Meteo):** varre a região e penaliza o **tempo** das rotas conforme
  a chuva real, de forma **proporcional** ao trecho atingido.
- **Balança distância × peso:** prioriza entregar cargas pesadas cedo, evitando arrastar
  peso em desvios (conceito de ton-quilômetro), com controle ajustável.
- **Múltiplas cargas** simultâneas, cada uma com cor própria; escolha automática de veículo
  (pickup até 600 kg, caminhão acima) e limite de 12.000 kg por viagem.
- **Visualização didática do algoritmo:** a aba *Motor de Busca Online* anima o LRTA\* passo
  a passo (avaliar, aprender, mover).
- **Interface pensada para o operador**, com indicadores claros e mapa interativo.

<img width="1862" height="915" alt="image" src="https://github.com/user-attachments/assets/2477a926-26b7-46fd-8f60-5decac5455d9" />

---

## Como executar

Pré-requisito: **Python 3.10+**.

```bash
pip install -r requirements.txt
python app.py
```

Abra **http://localhost:5000** no navegador.

> **Internet:** as estradas reais e o clima vêm de serviços online (OSRM e Open-Meteo).
> Sem internet, o sistema continua funcionando em modo simplificado (linha reta).
> Para forçar o modo offline: `AGROROUTE_OFFLINE=1 python app.py`.

As cargas são salvas automaticamente em `dados.json` (criado na primeira carga).

---

## Como usar

1. **Configurações → Frota:** cadastre os veículos (placa + tipo). Uma pickup e um caminhão
   já vêm cadastrados na primeira execução.
2. **Cargas → Nova carga:** adicione clientes (nome, fazenda, latitude, longitude, peso).
   O veículo é definido pelo peso total.
3. **Fechar carga → Calcular rota:** a IA define a ordem de visita e traça a rota por
   estradas reais, já com o retorno à base.
4. **Ocorrências** (toolbar no mapa):
   - **Chuva** (raio 10 km): penaliza só o **tempo**, proporcional ao trecho na chuva.
   - **Acidente / ponte / obra / interdição:** bloqueio total, força um **desvio real**.
   - **Buscar chuva na região:** consulta a precipitação **ao vivo** (Open-Meteo).
5. **Finalizar** quando a entrega termina; o veículo volta a ficar disponível.
6. **Histórico:** filtra por data e mostra a sequência de cada carga.

Ciclo da carga: `montando → fechada → calculada → finalizada`.

---

## A técnica de IA (LRTA\*)

O núcleo está em **`src/lrta.py`** (classe `MotorLRTA`). A cada passo o agente:

1. **Avalia** os vizinhos do nó atual por `f = custo(atual, vizinho) + H(vizinho)`;
2. **Aprende**, atualizando a heurística do nó atual: `H(atual) = max(H(atual), melhor_f)`
   (variante monótona, que garante convergência);
3. **Move** para o melhor vizinho e repete.

A heurística inicial `H` é a distância em linha reta (Haversine). Bloqueios entram como
**custo infinito** (a IA descarta o trecho); a **chuva** afeta apenas o tempo. É a Busca
Online aplicada a um ambiente que muda em tempo real (estradas e clima).

| Arquivo | Papel |
|---|---|
| `src/lrta.py` | **Núcleo do LRTA\*** (avaliar, aprender, mover). |
| `src/planejador.py` | Orquestra a carga: ordem de entregas, contorno de bloqueios, retorno à base. |
| `src/roteamento.py` | Estradas reais via OSRM (cache + fallback). |
| `src/ocorrencias.py` | Impacto das ocorrências (bloqueio x chuva proporcional). |
| `src/clima.py` | Chuva real ao vivo (Open-Meteo). |
| `src/persistencia.py` | Salva/lê as cargas em `dados.json`. |
| `app.py` | Servidor Flask (API + interface). |

---

## Estrutura do projeto

```
agroroute_ai/
├── app.py              # servidor Flask + API
├── requirements.txt
├── README.md
├── src/
│   ├── lrta.py         # núcleo da IA (LRTA*)
│   ├── planejador.py   # rota, ordem de entregas, contorno, retorno à base
│   ├── roteamento.py   # estradas reais (OSRM)
│   ├── ocorrencias.py  # bloqueios e chuva
│   ├── clima.py        # chuva real ao vivo (Open-Meteo)
│   └── persistencia.py # JSON local
└── ui/
    ├── index.html
    ├── styles.css
    └── app.js
```

---

## Tecnologias

- **Backend:** Python, Flask
- **IA:** LRTA\* (Learning Real-Time A\*), implementação própria
- **Mapas/rotas:** Leaflet + OSRM (OpenStreetMap)
- **Clima:** Open-Meteo API
- **Frontend:** HTML, CSS e JavaScript (sem frameworks)

Desenvolvido por Arthur Xavier.

---

<sub>Projeto acadêmico, IFTM Campus Patrocínio, disciplina de Inteligência Artificial e Computacional.</sub>
