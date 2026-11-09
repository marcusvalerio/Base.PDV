# Central.PDV — Guia do dono

Documento de referência do dono da plataforma: o que está pronto, onde cada coisa fica, como operar no dia a dia e o que ainda falta fazer.
Atualizado em novembro de 2026.

> **Nada de senhas ou chaves aqui.** Elas ficam só no Vercel (variáveis de ambiente) e no painel central. Nunca coloque segredos neste repositório.

---

## 1. Pendências (o que falta você fazer)

| # | O quê | Onde | Por quê |
|---|---|---|---|
| 1 | **Cadastrar a chave Pix aleatória** (nome `MARCUS VALERIO`, cidade do banco) | Painel central › aba **Pix** › Salvar | Sem ela, a opção "Pagar com Pix" não aparece para os clientes. Use chave **aleatória** para não expor o CPF. |
| 2 | **Ligar a verificação em duas etapas** do painel central | Painel central › **Segurança** | Quem entra no central controla todos os clientes. |
| 3 | **Conferir o webhook do Stripe** | Stripe › Desenvolvedores › Webhooks | O endereço tem que ser `https://centralpdv.vercel.app/api/stripe/webhook`, com os eventos `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` e `invoice.payment_failed`. É o webhook que libera o cliente que paga com cartão. |
| 4 | **Conferir se o Stripe está em modo real** (não "modo de teste") e ver o prazo de repasse | Stripe › canto do painel; Saldo › Repasses | Em modo de teste o cartão do cliente não vale. |
| 5 | **Remover o endereço antigo `basepdv.vercel.app`** — só depois do item 3 | Vercel › projeto › Settings › Domains | Se o webhook ainda apontar para ele, os pagamentos com cartão param de liberar clientes. |
| 6 | **Apagar a variável `SETUP_TOKEN`** | Vercel › Settings › Environment Variables | Só servia para criar o primeiro administrador central (já feito). |
| 7 | **Preencher seus dados nos termos de uso** | `web/public/termos.html` (bloco de contato fica oculto até ser preenchido) | Obrigatório para o cliente saber quem é o responsável. |
| 8 | **Deixar o repositório do GitHub privado** | GitHub › Settings › General › Danger Zone | O código não precisa ser público. |
| 9 | **Verificação em duas etapas** no Vercel, Stripe, Neon e GitHub | Configurações de cada serviço | Quem entra nessas contas controla o sistema. |
| 10 | **Cópia de segurança semanal** | Painel central › cliente › "Baixar cópia de segurança" | O plano gratuito do Neon **não faz cópia automática** (só permite voltar até 6 horas). Foi feita uma cópia manual em 06/11 ("antes-do-primeiro-cliente"). |

### Decisões em aberto (quando quiser)
- **Plano Pro** (Pix automático pelo Mercado Pago): pronto no código, aparece como "em breve". Para lançar: criar o preço Pro no Stripe (`STRIPE_PRICE_ID_PRO`) e o app do Mercado Pago (`MP_CLIENT_ID`, `MP_CLIENT_SECRET`; redirecionamento `https://centralpdv.vercel.app/api/mp/callback`). Testar com um Pix real de R$ 1 antes.
- **Aviso de novo cadastro/pagamento** (e-mail ou mensagem): exige ligar um serviço de envio.
- **Cópia de segurança automática diária**: dá para o próprio sistema gerar.
- **Preço por item nas mesas** (hoje só no balcão).
- **Emissão fiscal**: em espera; nenhuma integração feita.

---

## 2. Onde fica cada coisa

| O quê | Endereço / lugar |
|---|---|
| Site (página de vendas) | https://centralpdv.vercel.app |
| Sistema dos clientes | https://centralpdv.vercel.app/app |
| Cadastro com 5 dias grátis | https://centralpdv.vercel.app/app/cadastro |
| **Painel central (seu)** | https://centralpdv.vercel.app/central |
| Manual completo (com vídeos) | https://centralpdv.vercel.app/manual.html |
| Código | GitHub `marcusvalerio/Base.PDV` — a branch `main` publica sozinha no Vercel |
| Hospedagem | Vercel, projeto `basepdv` |
| Banco de dados | Neon, projeto `central-pdv` (Postgres, região São Paulo) |
| Cartão | Stripe |

### Variáveis de ambiente no Vercel (só os nomes)
| Nome | Para quê |
|---|---|
| `DATABASE_URL` | Conexão com o banco (Neon) |
| `APP_URL` | `https://centralpdv.vercel.app` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Cartão (secretos) |
| `STRIPE_PRICE_ID` | Mensalidade R$ 80 (plano Essencial) |
| `STRIPE_SETUP_PRICE_ID` | Instalação R$ 170 (1ª cobrança = R$ 250) |
| `SIGNUP_TRIAL_DAYS` | Dias de teste grátis no cadastro pelo site (hoje **5**; 0 desliga). Se mudar, ajuste também o texto "5 dias grátis" em `web/public/index.html` e `novo.html`. |
| `STRIPE_PRICE_ID_PRO`, `MP_CLIENT_ID`, `MP_CLIENT_SECRET` | Plano Pro (ainda não usados) |
| `SETUP_TOKEN` | Pode apagar (item 6) |

---

## 3. Como operar no dia a dia

### Cobrança por Pix (principal)
1. O cliente vê **"Pagar com Pix"** em Administração › Assinatura (ou na tela de sistema fora do ar), com o QR do valor certo: **R$ 250** na 1ª vez, **R$ 80** nas seguintes.
2. Ele paga e toca em **"Já paguei"** → o sistema dele fica **liberado na hora por 3 dias**.
3. No painel central aparece a faixa amarela **"pagamentos por Pix para confirmar"**. Confira no app do banco:
   - **"Recebi, confirmar"** → libera **30 dias** (somados ao que faltava).
   - **"Não recebi"** → tira a liberação.
4. Faltando 3 dias para vencer, o cliente vê o aviso **"Pagar agora"**.
5. Na lista de clientes: selos **"Pix até dd/mm"**, **"Pix a confirmar"**, **"Teste até…"**, **"Pago (cartão)"**, **"Isento"**.

> Se você não confirmar em 3 dias, o cliente volta a ficar bloqueado. Entre no painel pelo menos a cada 2 dias.

### Cobrança por cartão (opcional)
Botão **"Assinar com cartão"** na Assinatura → Stripe cobra todo mês sozinho; o webhook libera/bloqueia automaticamente.

### Teste grátis
- Quem se cadastra pelo site ganha **5 dias** sem cartão.
- Nos **3 últimos dias**, o aviso no topo mostra **"Assinar agora"** e o link **"Saiba como assinar"** (vídeo de 1 min).
- Vencido sem pagamento: sistema fora do ar (dados guardados) até pagar.

### Atendimento rápido (painel central)
| Situação | O que fazer |
|---|---|
| Funcionário esqueceu a senha | O **administrador do estabelecimento** faz: Usuários › Editar › **"Gerar e salvar nova senha"**. |
| Dono esqueceu a senha | Painel central › cliente › Usuários › Redefinir senha. |
| "Muitas tentativas" no login | Espera 15 minutos (bloqueio de segurança após 5 erros). |
| Usuário não entra de jeito nenhum | Conferir em Usuários se a caixa **"Ativo"** está marcada. |
| Dar mais dias de teste | Painel central › cliente › "Dias de teste (a partir de hoje)" › Aplicar. |
| Cortesia (não cobrar) | Painel central › cliente › "Marcar como isento". |
| Cliente sumiu / parou de vender | Lista do central: "Saúde", "Vendas (30 dias)", "Última venda" e botão do WhatsApp. |
| Avisar todos (manutenção, novidade) | Painel central › aba Avisos. |

### Material de ajuda (todos no botão **?** do sistema e no manual)
- Tour guiado (repete quando quiser)
- Vídeo do caixa (operador) · Vídeo do administrador · Vídeo "Como assinar"
- Manual completo: `/manual.html`

---

## 4. O que o sistema faz (resumo)
- Venda no balcão com leitor/câmera, Pix com QR, cartão, dinheiro com troco, fiado.
- **Preço por item só naquela venda** (com código de cancelamento e motivo; fica na Auditoria).
- Mesas por pessoa, caixa (abertura, suprimento, retirada, fechamento com diferença), cancelamento com código.
- Produtos, catálogo pronto, estoque, validade, inventário, reposição, análise.
- **Códigos de barras**: gerar EAN-13 interno, etiquetas (A4 ou térmica) e **folha de códigos** para o balcão (Administração › Códigos de barras).
- Funciona sem internet no balcão (vendas sobem depois).
- Abertura animada, tour, manual e vídeos.
- Vários estabelecimentos, cada um com dados separados; painel central para administrar todos.

## 5. Para quem for mexer no código
- Instalação, testes e estrutura: `README.md` e `docs/ARQUITETURA.md`.
- `npm test` roda os testes (109 hoje); `npm run build` compila; `npm run demo` sobe um sistema de demonstração com dados fictícios.
- Toda mudança em `main` publica sozinha no Vercel; as atualizações do banco (pasta `server/src/migrations`) rodam sozinhas ao subir.
