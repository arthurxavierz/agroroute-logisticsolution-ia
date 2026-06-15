# AgroRoute AI

### Planejamento dinâmico de rotas em tempo real para revendas agrícolas com LRTA\*

> **Disciplina:** Inteligência Artificial e Computacional · **Técnica:** Aula B: Busca Online (LRTA\*)
> **Instituição:** IFTM Campus Patrocínio

Plataforma web para **planejamento e replanejamento de rotas** de entrega de
insumos agrícolas, com **estradas reais** (OpenStreetMap), **múltiplas cargas
simultâneas** (caminhão + pickup) e a técnica de IA **Busca Online, LRTA\***.

> Disciplina: Inteligência Artificial e Computacional · IFTM Campus Patrocínio
> Técnica IAC: **Aula B, Busca Online (LRTA\*)**

---

## Como executar (3 passos)

Pré-requisito: **Python 3.10+**.

```bash
pip install -r requirements.txt   # instala flask e requests
python app.py                     # inicia o servidor
# abra no navegador:  http://localhost:5000
```

O sistema inicia **zerado**, mostrando a **data atual**. As cargas são salvas
automaticamente em `dados.json` (criado na primeira carga).

> **Internet:** as estradas reais vêm do OSRM. Com internet, a rota é desenhada
> **pelas estradas**. Sem internet, funciona em linha reta (não quebra). Para
> forçar o modo offline: `AGROROUTE_OFFLINE=1 python app.py`.

---

## Fluxo de uso

1. **Configurações → Frota**: cadastre os veículos (placa + tipo). Uma carga só é
   calculada se houver um veículo do tipo certo **disponível**.
2. **Cargas → "Iniciar Nova Carga"**: cada carga recebe uma **cor única** no mapa.
3. **Adicione clientes** (nome, fazenda, lat, lng, peso). O veículo é definido pelo
   peso total: **≤ 600 kg → Pickup** · **> 600 kg → Caminhão**.
4. **"Fechar carga"** → **"Calcular rota"**. O veículo escolhido entra **"em rota"**.
   A rota passa por **estradas reais** e inclui o **retorno à base**.
5. **"Finalizar"** quando a entrega termina → o veículo volta a ficar **disponível**.
6. **Ocorrências** (toolbar no mapa), com DOIS comportamentos:
   - **Chuva** (raio 10 km): só **encarece o tempo** (a pista segue passável).
   - **Acidente / Ponte / Obra** (raio 500 m) e **Siga e Pare / Estrada interditada**
     (trecho de 2 cliques): **bloqueio total**, a IA é obrigada a achar **outra rota
     real pelas estradas**, contornando a área. Recálculo em cascata em todas as rotas.
7. **Histórico**: filtra por data e mostra os **clientes e a sequência** de cada carga.

> Ciclo da carga: `montando → fechada → calculada → finalizada`.


---

## Onde está a técnica IAC (para a banca)

| Arquivo | Classe / função | Papel |
|---------|------------------|-------|
| `src/lrta.py` | **`MotorLRTA`** | **Núcleo do LRTA\***. `passo()` avalia vizinhos e **aprende** `H(atual)=mín(custo+H(vizinho))`. |
| `src/roteamento.py` | `ServicoRoteamento` | **Estradas reais** via OSRM (cache + fallback). |
| `src/ocorrencias.py` | `GerenciadorOcorrencias` | Impacto espacial (raio/trecho) sobre o custo. |
| `src/planejador.py` | `Planejador` | **Malha de waypoints reais** + ordem de entregas + **retorno à base** + LRTA\* por trecho. |
| `src/persistencia.py` | `Persistencia` | Salva/lê cargas em `dados.json` (com data). |
| `app.py` | Flask | API e entrega da interface. |

**Como o desvio funciona (garantia de rota alternativa real):** quando um trecho fica
bloqueado (custo infinito), o `Planejador` não desiste, ele gera **pontos de fuga**
laterais ao redor do bloqueio (3 distâncias para cada lado) e pede ao OSRM rotas
`A -> ponto de fuga -> B`. Escolhe o **contorno mais curto que realmente evita** a área
interditada, mesmo que seja uma volta grande por outra cidade. Só marca um cliente como
**inacessível** se nenhum contorno existir (beco sem saída real), e, nesse caso, os
números (tempo/economia) não são inflados. A **chuva** penaliza apenas o **tempo**, sem
alterar a quilometragem nem o trajeto. O LRTA* roda em todos os trechos (variante
monótona) para registrar o aprendizado/replanejamento.

Linha-chave do aprendizado (`src/lrta.py`, `passo()`):
`self.H[atual] = melhor_f`, onde `melhor_f = mín(custo(atual,viz) + H(viz))`.

---

## Estrutura do projeto

```
agroroute_ai/
├── app.py                 # servidor Flask + API
├── dados.json             # persistência (criado automaticamente)
├── requirements.txt
├── README.md
├── src/                   # uma classe por arquivo
│   ├── roteamento.py      # estradas reais (OSRM)
│   ├── ocorrencias.py
│   ├── lrta.py            # núcleo da IA (LRTA*)
│   ├── planejador.py      # rota + retorno à base
│   └── persistencia.py    # JSON local com data
└── ui/
    ├── index.html
    ├── styles.css
    └── app.js
```


## Indicadores e didática (atualização)

- **KPIs do topo** não somam mais o tempo (não faria sentido com veículos distintos
  rodando em paralelo, nem com cargas já finalizadas). Agora mostram: **cargas ativas**,
  **km planejados** (soma faz sentido, é combustível), **maior rota** (o gargalo do dia,
  em minutos) e **economia**.
- **Economia (opção B):** a rota otimizada é comparada com a **média de várias ordens de
  visita aleatórias** (amostra determinística). Representa o ganho real do otimizador e
  quase nunca dá zero. O painel mostra também o **percentual**.
- **Histórico** ganhou um **resumo do dia por veículo**: km rodados e entregas por placa,
  finalizadas vs. em andamento e a divisão caminhão/pickup.
- **Motor de Busca Online** ganhou uma **animação passo a passo** (reproduzir/avançar) que
  mostra, a cada passo, o nó atual, os vizinhos avaliados com seu **f = custo + H**, qual
  foi escolhido e como o **H(s)** é aprendido, além de textos explicando, em linguagem
  simples, o que é busca online e heurística.


## Desempenho e desvio (correção importante)

O desvio de bloqueios agora é **rápido e garantido**. Em vez de testar dezenas de
pontos de contorno (o que deixava o recálculo lento), o sistema pede ao OSRM as
**rotas alternativas** em **uma única chamada** (`alternatives=true`) e usa a primeira
que não cruza o bloqueio. Se nenhuma servir, tenta no máximo 2 pontos de contorno.
Além disso, o serviço de rotas virou um **cache compartilhado** entre requisições -
recalcular após uma ocorrência reaproveita o que já foi baixado e leva segundos.

A aba **Motor de Busca Online** agora traz uma **árvore de busca interativa** (com
nós abstratos S…G), que anima a exploração nó a nó, fronteira, nó atual, nós já
explorados e o caminho da solução, para explicar o algoritmo **sem depender de
calcular nenhuma rota antes**.


## Correção do desvio (definitiva) + tratamento visual

O contorno de bloqueios foi refeito de forma robusta. Antes, os pontos de desvio
ficavam a 25 km perpendiculares ao meio da rota, no meio do nada, sem estrada
paralela, e o caminho até eles voltava a cruzar o bloqueio, então tudo era
descartado e a rota sumia. Agora os pontos de desvio são gerados **ao redor do
próprio bloqueio**, em raios pequenos (1.5 a 20 km) e em 8 direções. O OSRM
'encaixa' cada ponto na **estrada mais próxima** e é **obrigado a passar por ele**
(rota com waypoint intermediário), produzindo um caminho real que entra/sai por
outro ponto, como um GPS contornando um obstáculo. Para no menor raio que
funciona (desvio mais curto e natural).

Tratamento visual: se há desvio, ele é traçado e marcado com **↺**, e o mapa
mostra **"Rota recalculada: desvio aplicado"**. Se realmente não existe alternativa
(via única), a rota **não some**, fica **tracejada em vermelho** com o aviso
**"Sem rota alternativa até [cliente]"**.

Frota inicial: na primeira execução já são cadastrados uma **pickup FGH1I22** e um
**caminhão TKC5I67**.


## Polimento de UX (versão final do dia)

- **Botão flutuante "Calcular/Recalcular rota" no mapa:** acesso rápido para
  (re)calcular sem sair da tela do mapa, útil quando a rota não aparece desenhada.
  Ele calcula a carga em edição; se não houver, recalcula as já calculadas ou fecha
  e calcula as pendentes.
- **Toolbar de ocorrências recolhível:** começa fechada e abre/fecha pelo cabeçalho
  (tipo menu), liberando espaço no mapa.
- **Veículo citado na criação da carga:** mostra o tipo + a **placa** que será usada
  (ex.: Caminhão TKC5I67) e sinaliza em vermelho quando não há veículo livre.
- **Microanimações leves (CSS puro):** entrada suave de cards, hovers com leve
  elevação, botão flutuante com mola, e respeito a `prefers-reduced-motion`. Nada de
  bibliotecas, sem impacto no desempenho.


## Otimização de desempenho do recálculo

Três mudanças deixaram o (re)cálculo bem mais rápido sem alterar resultados:
1. **Economia sem contorno:** o cálculo da economia (24 ordens aleatórias) passou a
   usar a distância direta em cache, antes ele refazia o desvio do bloqueio em cada
   uma das 24 ordens, o que era o maior gargalo.
2. **Contorno em paralelo:** as 8 direções de cada raio de desvio são consultadas ao
   OSRM simultaneamente (I/O), então um anel inteiro custa ~1 ida-e-volta de rede.
3. **Pré-carga paralela:** as rotas diretas entre os pontos principais são baixadas em
   paralelo no início, e o cache é compartilhado entre requisições (recalcular
   reaproveita tudo e só busca o novo desvio).

Observação: a latência restante é do **servidor OSRM público** (gratuito e às vezes
lento). Para velocidade máxima numa demonstração, um OSRM local eliminaria essa espera,
mas exige instalação, as otimizações acima já tornam o uso pontual fluido.


## Clima real em tempo real (Open-Meteo)

Além das ocorrências manuais, o sistema busca **chuva real ao vivo** pela API gratuita
**Open-Meteo** (sem chave). Pelo botão **"Buscar clima na rota"**, ele consulta a
precipitação **apenas nas coordenadas das entregas** (não no mapa todo) e cria
ocorrências de chuva onde estiver chovendo **>= 0,8 mm/h** no momento da consulta.

- **Intensidade em 3 faixas:** fraca (0,8-1 mm, +15% no tempo), média (1-1,6 mm, +35%),
  forte (>1,6 mm, +60%). Como toda chuva, **penaliza só o tempo**, não a quilometragem.
- **Distinção visual:** a chuva real aparece em **ciano vivo com anel pulsante e selo
  "AO VIVO"**, diferente das ocorrências manuais/simuladas. Honestidade total com a banca
  sobre o que é dado real e o que é entrada manual.
- **Sob demanda:** a busca é manual (o operador controla), refletindo o estado do clima
  no instante da consulta.

Isto reforça o conceito de **busca online**: o ambiente (clima) é real e muda; o LRTA*
reage replanejando os tempos. A entrada manual continua disponível como garantia.


## Varredura regional de chuva + indicador de carregamento

- O botão agora é **"Buscar chuva na região"**: em vez de checar só as entregas, ele
  **varre uma grade (~100 km de raio, pontos a cada 15 km) ao redor da base** e marca
  TODAS as zonas com chuva real >= 0,8 mm/h, cada uma com seu círculo ciano e selo
  **"AO VIVO"**. Assim o operador enxerga onde está chovendo agora e cadastra a entrega
  lá. As consultas usam o modo **bulk** da Open-Meteo (poucas requisições, rápido).
- **Indicador de carregamento persistente:** enquanto a rota é processada, um aviso
  "Calculando/Recalculando rota..." com spinner fica visível no mapa até concluir
  (antes a mensagem sumia sozinha).


## Chuva proporcional (refinamento)

A penalidade de chuva agora é **proporcional à parte do trecho que está dentro da
chuva**, não mais liga/desliga. Cada trecho é dividido em pontos finos (~0,2 km) e o
fator de tempo é a média ponto a ponto: se só 20% do trecho está sob chuva forte
(x1,6), o fator é 0,8x1 + 0,2x1,6 = **1,12** (atrasa 12%, não 60%). A quilometragem
não muda, só o tempo. Bloqueios continuam liga/desliga (uma pontinha já interdita).


## Balança distância x peso (ordem de entregas)

A ordem de visita deixou de ser só "vizinho mais próximo". Agora usa
**chave = distância / (peso ^ beta)**, então clientes **pesados tendem a ir primeiro**,
evitando arrastar carga grande em desvios fora da direção principal (conceito de
**ton-quilômetro**). Há um **controle deslizante em Configurações** ("economia de
combustível" ↔ "aliviar carga pesada") que ajusta o beta: em 0%, é só distância
(comportamento clássico); padrão 70%. Quando os pesos são parecidos, vale a distância.
O mapa também ganhou uma **legenda** (ida, volta, bloqueado, chuva ao vivo, desvio).


## Limite de capacidade (12.000 kg)

O sistema não deixa fechar nem calcular uma carga acima de 12.000 kg. Ao exceder,
o painel do veículo avisa em vermelho e a ação é bloqueada com a orientação de usar
outro caminhão ou dividir a entrega em mais de uma carga. A regra vale também na API
(endpoint /api/planejar), como guarda defensiva.

## Limpeza de código

O backend passou por uma revisão: remoção de métodos sem uso (malha de waypoints antiga,
traços não utilizados) e comentários significativos nos trechos centrais (custo,
heurística, ordem de entregas, contorno e o núcleo LRTA*), facilitando a leitura.
