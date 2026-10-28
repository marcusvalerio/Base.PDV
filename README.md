# Central.PDV — bar e mercearia

PDV operacional (vendas, mesas/comandas, fiado, caixa) e administração (produtos, estoque, clientes, caixas, usuários, painel, análise e lista de reposição).

**Princípio:** simplicidade na operação, profundidade na gestão.

## Stack
- **Node.js ≥ 22.13** + Express + Zod (API em `server/src`)
- **PostgreSQL no Neon** (projeto `central-pdv`, banco `pdv`, região São Paulo), migrations versionadas em `server/src/migrations`; testes usam **PGlite** (Postgres em memória)
- **React 18 + Vite** (interface em `web/src`), tema claro/escuro automático, responsiva
- **Vitest + Supertest** (testes em `server/test`)

## Como executar
```bash
npm install
cp .env.example .env            # cole a DATABASE_URL do Neon
npm run migrate                 # aplica migrations pendentes (também roda ao iniciar)
npm run create-admin -- --name "Dono" --username dono --super   # super admin (pede a senha no terminal)
npm run create-admin -- --name "Gerente" --username gerente     # admin comum (opcional)
npm run dev                     # API :3001 + interface :5173
```
Entre com o **super admin** e libere os módulos em **Administração → Liberações** (Mesas, Fiado, Estoque, Inventário, Análise, Reposição, Auditoria vêm bloqueados). Depois: **Administração → Configurações**, defina o código do caixa e o código de cancelamento, cadastre produtos e crie as contas das funcionárias (perfil Operador).

Produção: `npm run build && npm start` (a API serve a interface em `dist/`). Use HTTPS e `COOKIE_SECURE=true`.

Demonstração com dados fictícios (Postgres em memória, nada vai ao Neon):
```bash
npm run build
PDV_DEMO_PASSWORD=uma-senha-qualquer PDV_DEMO_CASH_CODE=2468 npm run demo   # usuários: super / admin / caixa
```

## Testes
```bash
npm test          # testes de API e regras de negócio
npm run typecheck
```

## Variáveis de ambiente
| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | 3001 | Porta da API |
| `DATABASE_URL` | — | Conexão do Neon (obrigatória em produção; sem ela usa memória) |
| `DB_POOL_MAX` | 10 | Conexões por instância |
| `BUSINESS_TZ` | America/Sao_Paulo | Fuso para dias/relatórios |
| `COOKIE_SECURE` | false | `true` atrás de HTTPS |
| `SETUP_TOKEN` | — | Só no primeiro acesso ao painel central (`/central`) |
| `STRIPE_SECRET_KEY` | — | Chave secreta do Stripe (`sk_live_…` / `sk_test_…`) |
| `STRIPE_PRICE_ID` | — | Preço recorrente da assinatura (`price_…`) |
| `STRIPE_SETUP_PRICE_ID` | — | Complemento da 1ª cobrança (instalação), cobrado uma vez junto com a 1ª mensalidade (opcional). Ex.: instalação de R$ 250 já com o 1º mês = mensalidade R$ 80 + complemento R$ 170 |
| `STRIPE_WEBHOOK_SECRET` | — | Segredo do webhook (`whsec_…`) |
| `APP_URL` | — | Endereço do site, ex.: `https://basepdv.vercel.app` (volta do Checkout) |

Nenhum segredo é necessário em código. Senhas e códigos de caixa são guardados com hash scrypt.

Mais detalhes: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) e [docs/PENDENCIAS.md](docs/PENDENCIAS.md).

## Leitura de código de barras
- **Coletor / pistola USB ou Bluetooth (modo teclado):** basta ler — funciona no PDV, nas mesas, no inventário e no cadastro de produtos, mesmo sem clicar no campo.
- **Câmera do celular/tablet:** botão “Câmera”. Usa o leitor nativo do navegador (Chrome/Android) e, se não houver, a biblioteca ZXing (iPhone/Safari). **Requer HTTPS** (ou `localhost`).

## Publicar na Vercel
1. Importe o repositório na Vercel (o `vercel.json` já define build, saída `dist/` e a função `api/index.ts`).
2. Em **Settings → Environment Variables** (Production e Preview):
   - `DATABASE_URL` — string de conexão do Neon (use a do endpoint **-pooler**).
   - `DB_POOL_MAX` — `3` (funções serverless abrem poucas conexões cada).
   - `SETUP_TOKEN` — texto longo e aleatório, usado só no primeiro acesso.
   - `BUSINESS_TZ` — `America/Sao_Paulo`.
3. Faça o deploy e abra **/central** (o site em `/` é a apresentação; o sistema fica em `/app`): no primeiro acesso, informe o `SETUP_TOKEN` e crie o administrador central (dono da plataforma).
4. No painel central, crie cada estabelecimento (com o administrador dele), escolha teste grátis / assinatura / isento e as liberações.
5. O administrador do estabelecimento entra pela página inicial; em **Configurações** define o código do caixa e o de cancelamento.

## Perfis
- **Admin central** (`/central`): cria e suspende estabelecimentos, libera módulos, dá teste grátis ou isenção, redefine senhas.
- **Administrador** (de um estabelecimento): cadastros, equipe, relatórios, configurações e a assinatura.
- **Operador**: vende, mesas, fiado, caixa e contagem de inventário.

Cada estabelecimento tem um schema próprio no Postgres (`t_<nº>`); logins são únicos entre todos.

## Assinatura (Stripe)
1. No Stripe, crie um produto com preço **recorrente** (mensalidade) e copie o `price_…`. Para a taxa de instalação, crie um preço **avulso** (one-time) e use em `STRIPE_SETUP_PRICE_ID`.
2. Em **Developers → Webhooks**, adicione `https://SEU-SITE/api/stripe/webhook` com os eventos
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted` e `invoice.payment_failed`. Copie o `whsec_…`.
3. Ative o **Customer portal** (Settings → Billing → Customer portal).
4. Preencha as variáveis `STRIPE_*` e `APP_URL` na Vercel e faça o deploy.

Sem assinatura ativa (ou com pagamento recusado), o sistema sai do ar na hora para o estabelecimento;
o administrador vê o botão para pagar e volta assim que o Stripe confirma.

## Modo offline
O caixa continua vendendo sem internet (dinheiro, Pix e cartão): a venda fica guardada no aparelho e é
enviada sozinha quando a conexão volta, com o horário real. Fiado, mesas, cadastros, relatórios e fechamento
de caixa precisam de internet. É preciso ter aberto o sistema com internet pelo menos uma vez no aparelho.
