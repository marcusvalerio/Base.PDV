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
3. Faça o deploy e abra o site: aparece **Configuração inicial**. Informe o `SETUP_TOKEN` e crie o super administrador (dono).
4. Depois disso a tela some (só funciona com o banco sem usuários). Pode remover o `SETUP_TOKEN` da Vercel.
5. Entre como super admin → **Administração → Liberações** para liberar os módulos; em **Configurações**, defina o código do caixa e o de cancelamento.
