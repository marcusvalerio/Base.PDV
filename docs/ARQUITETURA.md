# Arquitetura e decisões

## Auditoria inicial
O repositório continha apenas um `README.md` ("Central.OS"): sem código, banco, autenticação ou testes. Não havia nada a preservar; a stack foi escolhida do zero.

## Decisões
- **PostgreSQL no Neon** (projeto `central-pdv`, branch `main`, banco `pdv`, sa-east-1). `db.ts` expõe uma interface assíncrona (`all/one/run/tx`) sobre um pool `pg`; transações aninhadas viram SAVEPOINT. Nos testes e no modo demo, o mesmo SQL roda no **PGlite** (Postgres em WASM, em memória).
- **Concorrência** (vários caixas simultâneos): estoque atualizado com `UPDATE ... SET stock_milli = stock_milli + ? RETURNING`; caixa, mesa, cliente e venda travados com `SELECT ... FOR UPDATE` nas operações críticas; idempotência garantida por `UNIQUE` (corrida resolvida devolvendo a operação vencedora); contagem de inventário somada com `ON CONFLICT DO UPDATE`.
- **Migrations**: `server/src/migrations/*.sql`, aplicadas em transação com `pg_advisory_xact_lock` (seguro com mais de uma instância). Registro em `schema_migrations`.
- **Dinheiro em centavos (INTEGER)** e **quantidades em milésimos da unidade** (`qty_milli`): 1 L de chopp = 1000, 300 mL = 300; 1 unidade = 1000. Valor da linha = `round(preço × qtd / 1000)`. Sem ponto flutuante.
- **Datas** em UTC (ISO); dias e períodos são calculados no fuso `BUSINESS_TZ`.
- **Datas** em texto ISO-8601 UTC (ordenáveis).
- **Sessões** em cookie `HttpOnly; SameSite=Strict`, token aleatório armazenado como SHA-256. Bloqueio, troca de perfil ou de senha encerram as sessões. Limite de 5 tentativas de login (bloqueio de 5 min).
- **CSRF**: toda escrita exige o cabeçalho `X-Requested-With: pdv`.
- **Autorização no servidor**: middleware `admin` em todas as rotas administrativas; operador não recebe custo de produtos.
- **Preço definido pelo servidor**: o navegador envia só produto e quantidade.
- **Idempotência**: vendas, fechamentos de comanda e recebimentos de fiado exigem `idempotencyKey` única (restrição no banco). Reenvio devolve o mesmo resultado.
- **Transações**: venda + itens + estoque + fiado são gravados atomicamente (`BEGIN IMMEDIATE`).
- **Estoque só muda por `stock_movements`** (venda, cancelamento, entrada, ajuste, perda, inventário), com usuário, motivo, saldo e referência.
- **Comanda ≠ dívida**: itens de mesa ficam `PENDING` sem gerar venda nem baixa de estoque; ao fechar (individual ou mesa inteira) viram venda. Itens pagos ficam ligados à venda e não podem ser cobrados de novo. Correções marcam o item como `VOIDED` com motivo.
- **Fiado**: `receivables` (1 por venda, `UNIQUE(sale_id)`) guarda valor original, acréscimo aplicado e total; pagamentos abatem as dívidas mais antigas (`receivable_allocations`).
- **Caixa**: vários caixas abertos ao mesmo tempo, no máximo um por usuário (índice único parcial, migration 002). Vendas, recebimentos e movimentos vão para o caixa de quem registrou; relatórios somam todos. O administrador acompanha os caixas abertos no Painel e em Caixas (`GET /cash/active`). Só quem abriu (ou um administrador) fecha o caixa. Código validado no servidor (modo único ou individual, configurável). Fechamento grava o resumo congelado e não pode ser repetido. Faturamento, vendas a prazo e entradas de dinheiro são separados.
- **Cancelamento** de venda: qualquer usuário com o **código único de cancelamento** (configurado pelo administrador, guardado com hash). Operador só cancela vendas do próprio caixa; o caixa da venda precisa estar aberto. Preserva a venda como `CANCELLED`, devolve estoque, cancela o fiado (se não houver pagamento). Venda de mesa: os itens voltam a `PENDING` na mesa, que é reaberta se estava encerrada. Relatórios contam apenas `COMPLETED`.
- **Auditoria**: `audit_log` para login, falhas, alterações de usuários, configurações, produtos, estoque, caixa, vendas e comandas.

## Módulos (API em `server/src/app.ts`)
| Módulo | Serviço | Rotas |
|---|---|---|
| Autenticação/usuários | `services/users.ts` | `/auth/*`, `/users` |
| Produtos/categorias | `services/products.ts` | `/products`, `/categories` |
| PDV | `services/sales.ts` | `/sales` |
| Fiado | `services/customers.ts` | `/customers`, `/customers/:id/payments` |
| Caixa | `services/cash.ts` | `/cash/*` |
| Mesas | `services/tabs.ts` | `/tabs/*` |
| Estoque | `services/stock.ts` | `/stock/*` |
| Painel/Análise/Reposição | `services/analytics.ts` | `/dashboard`, `/analytics`, `/restock` |
| Configurações | `services/settings.ts` | `/settings` |

## Análise
- Filtros: hoje, 7/15/30 dias, mês atual, intervalo; categoria e produto.
- Comparação com o período anterior de mesma duração.
- Margem bruta usa o custo **registrado no item no momento da venda**; quando parte do faturamento não tem custo, a interface indica que é estimativa parcial.
- Lucro líquido **não** é calculado (não há registro de despesas).
- Reposição: média diária × (prazo de reposição + reserva), mínimo = estoque mínimo; histórico < 7 dias é sinalizado. Nada é pedido automaticamente.

## Limitações conhecidas
- Validade por lote é informativa: não há baixa por lote (FIFO).
- Cancelamento de vendas de caixas já fechados não está disponível (exige procedimento administrativo a definir).
- Ajuste de quantidade de chopp no estoque é feito em litros como qualquer produto; o método real de controle (barril, medidor) ainda será avaliado.

## Super administrador e liberação de módulos
- `users.is_super_admin` (migration 003). Criado pela linha de comando (`--super`) ou por outro super admin. Admin comum não altera, bloqueia nem cria super admin.
- Módulos liberáveis (`services/modules.ts`): mesas, fiado, estoque, inventario, analise, reposicao, auditoria. Começam **bloqueados**. O bloqueio é aplicado no servidor (middleware `mod()` por rota; venda/fechamento a prazo exigem `fiado`) e a interface esconde menus e telas.
- Sempre disponíveis: Vender, Caixa, Produtos, Vendas, Caixas, Usuários, Configurações, Painel.

## Inventário e acuracidade
- Sessões (`inventory_sessions` / `inventory_session_items`): **Geral**, **Por categoria** ou **Parcial (cíclico)**; **contagem cega** opcional (padrão).
- Contagem por coletor (cada leitura soma 1), câmera, ou digitando a quantidade (obrigatório para L/kg). “Somar” permite contar em vários locais; “Substituir” é recontagem.
- Para cada item é guardado o saldo do sistema **no momento da contagem**: vendas posteriores não geram divergência falsa; o ajuste aplica só a diferença.
- **Acuracidade por item** = itens sem divergência ÷ itens contados. **Acuracidade em valor** = 1 − Σ|divergência × custo| ÷ valor do sistema (itens com custo). Itens não contados ficam fora.
- Operadores contam; somente admin cria, vê o sistema durante contagem cega, conclui (com ou sem ajuste) ou descarta. O histórico mostra a evolução da acuracidade e se cada inventário atingiu a **meta definida pelo administrador** (`inventory_accuracy_target`, % por item, em Configurações).
