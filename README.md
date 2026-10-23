# Central PDV — bar e mercearia

PDV operacional (vendas, mesas/comandas, fiado, caixa) e administração (produtos, estoque, clientes, caixas, usuários, painel, análise e lista de reposição).

**Princípio:** simplicidade na operação, profundidade na gestão.

## Stack
- **Node.js ≥ 22.13** + Express + Zod (API em `server/src`)
- **SQLite** embutido (`node:sqlite`), migrations versionadas em `server/src/migrations`
- **React 18 + Vite** (interface em `web/src`), tema claro/escuro automático, responsiva
- **Vitest + Supertest** (testes em `server/test`)

## Como executar
```bash
npm install
cp .env.example .env            # ajuste se necessário
npm run create-admin -- --name "Seu Nome" --username seu.login   # pede a senha no terminal
npm run dev                     # API :3001 + interface :5173
```
Depois de entrar como administrador: **Administração → Configurações → Definir código** do caixa, cadastre produtos e crie as contas das funcionárias (perfil Operador).

Produção: `npm run build && npm start` (a API serve a interface em `dist/`). Use HTTPS e `COOKIE_SECURE=true`.

Demonstração com dados fictícios:
```bash
PDV_DEMO_PASSWORD=uma-senha-qualquer PDV_DEMO_CASH_CODE=2468 DATABASE_PATH=./data/demo.db npm run seed:demo
DATABASE_PATH=./data/demo.db npm run dev:api   # usuários: admin / caixa
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
| `DATABASE_PATH` | ./data/pdv.db | Arquivo do banco |
| `BUSINESS_TZ` | America/Sao_Paulo | Fuso para dias/relatórios |
| `COOKIE_SECURE` | false | `true` atrás de HTTPS |

Nenhum segredo é necessário em código. Senhas e códigos de caixa são guardados com hash scrypt.

Mais detalhes: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) e [docs/PENDENCIAS.md](docs/PENDENCIAS.md).
