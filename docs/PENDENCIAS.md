# Pendências que dependem dos proprietários

1. **Acréscimo do fiado** — definido: valor configurável **por unidade vendida** (padrão R$ 0,50; chopp/kg contam 1 por item). Sem juros, multas ou cobranças recorrentes.
2. **Código de caixa** — único da loja ou individual? Ambos estão prontos (Configurações → Caixa).
3. **Operadoras cadastrando clientes** — hoje permitido (só nome/telefone) para não travar o fiado no balcão. Edição e bloqueio são só do administrador.
4. **Venda sem estoque registrado** — permitida por padrão (estoque fica negativo e aparece nos alertas). Pode ser desativada.
5. **Controle de estoque do chopp** — por litro vendido; definir se haverá controle por barril/perdas de espuma.
6. **Prazo de reposição e reserva de segurança** — não configurados; a reposição usa 7 dias como referência até serem informados.
7. **Cancelamentos após fechamento do caixa e estornos de fiado pago** — definir o procedimento administrativo.
8. **Código de cancelamento** — implementado como código próprio (separado do código do caixa). Se preferirem usar o mesmo, basta cadastrar o mesmo número nos dois.
9. **Emissão fiscal** — em espera (stand by) por decisão dos proprietários; nenhuma integração foi feita.

## Cartão
- Débito e crédito separados no pagamento, cada um com acréscimo opcional (R$ por unidade ou % sobre o total) configurado pelo administrador. Sem valor = sem acréscimo.

## Próxima etapa combinada (ainda não implementada)
- **Contas dos colaboradores pelo administrador:** login no formato `nome.sobrenome`, celular opcional, envio das credenciais pelo WhatsApp, revogar acesso e redefinir senha pelo admin, senha somente com letras. Será tratado junto com a revisão da autenticação principal (hoje a senha exige 8+ caracteres de qualquer tipo).

## Plataforma (vários estabelecimentos)
- Cada estabelecimento tem schema próprio no Postgres; o admin central (`/central`) cria, libera módulos, suspende, isenta e dá dias de teste.
- Assinatura: R$ 80,00/mês; 1ª cobrança R$ 250,00 (mensalidade + complemento de instalação R$ 170,00), só na primeira assinatura.
- Falta: `STRIPE_SECRET_KEY` (chave secreta da conta oficial) na Vercel. Sem ela, só estabelecimentos isentos ou em teste funcionam.
- Nome público da conta Stripe ("Fade Studio") aparece na fatura do cartão; ajustar em Settings → Business → Public details se quiser "Central.PDV".

## Segurança (manutenção)
- `npm audit` aponta o zod 3 (consumo de memória com listas enormes). Mitigado: corpo das requisições limitado a 200 KB e todas as listas com tamanho máximo. Atualizar para zod 4 numa janela tranquila (muda a API).
