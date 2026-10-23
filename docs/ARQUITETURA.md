# Arquitetura e decisões

## Auditoria inicial
O repositório continha apenas um `README.md` ("Central.OS"): sem código, banco, autenticação ou testes. Não havia nada a preservar; a stack foi escolhida do zero.

## Decisões
- **SQLite embutido**: um único estabelecimento, zero operação de servidor, backups por cópia de arquivo, transações ACID. Os serviços usam SQL padrão; migrar para PostgreSQL exige trocar `db.ts` e ajustar SQL pontual.
- **Dinheiro em centavos (INTEGER)** e **quantidades em milésimos da unidade** (`qty_milli`): 1 L de chopp = 1000, 300 mL = 300; 1 unidade = 1000. Valor da linha = `round(preço × qtd / 1000)`. Sem ponto flutuante.
- **Datas** em UTC (ISO); dias e períodos são calculados no fuso `BUSINESS_TZ`.
- **Sessões** em cookie `HttpOnly; SameSite=Strict`, token aleatório armazenado como SHA-256. Bloqueio, troca de perfil ou de senha encerram as sessões. Limite de 5 tentativas de login (bloqueio de 5 min).
- **CSRF**: toda escrita exige o cabeçalho `X-Requested-With: pdv`.
- **Autorização no servidor**: middleware `admin` em todas as rotas administrativas; operador não recebe custo de produtos.
- **Preço definido pelo servidor**: o navegador envia só produto e quantidade.
- **Idempotência**: vendas, fechamentos de comanda e recebimentos de fiado exigem `idempotencyKey` única (restrição no banco). Reenvio devolve o mesmo resultado.
- **Transações**: venda + itens + estoque + fiado são gravados atomicamente (`BEGIN IMMEDIATE`).
- **Estoque só muda por `stock_movements`** (venda, cancelamento, entrada, ajuste, perda, inventário), com usuário, motivo, saldo e referência.
- **Comanda ≠ dívida**: itens de mesa ficam `PENDING` sem gerar venda nem baixa de estoque; ao fechar (individual ou mesa inteira) viram venda. Itens pagos ficam ligados à venda e não podem ser cobrados de novo. Correções marcam o item como `VOIDED` com motivo.
- **Fiado**: `receivables` (1 por venda, `UNIQUE(sale_id)`) guarda valor original, acréscimo aplicado e total; pagamentos abatem as dívidas mais antigas (`receivable_allocations`).
- **Caixa**: um caixa aberto por vez (índice único parcial). Código validado no servidor (modo único ou individual, configurável). Fechamento grava o resumo congelado e não pode ser repetido. Faturamento, vendas a prazo e entradas de dinheiro são separados.
- **Cancelamento** de venda: somente administrador, enquanto o caixa está aberto; preserva a venda como `CANCELLED`, devolve estoque, cancela o fiado (se não houver pagamento). Relatórios contam apenas `COMPLETED`.
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
- Cancelamento de vendas de comanda e de caixas já fechados não está disponível (exige procedimento administrativo a definir).
- Ajuste de quantidade de chopp no estoque é feito em litros como qualquer produto; o método real de controle (barril, medidor) ainda será avaliado.
