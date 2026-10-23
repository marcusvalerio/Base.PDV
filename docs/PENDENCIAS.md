# Pendências que dependem dos proprietários

1. **Acréscimo do fiado** — implementado como valor fixo por venda a prazo (padrão R$ 0,50, editável em Configurações). Confirmar se é por venda, por item, percentual ou por período. Nenhum juro/multa foi implementado.
2. **Código de caixa** — único da loja ou individual? Ambos estão prontos (Configurações → Caixa).
3. **Operadoras cadastrando clientes** — hoje permitido (só nome/telefone) para não travar o fiado no balcão. Edição e bloqueio são só do administrador.
4. **Venda sem estoque registrado** — permitida por padrão (estoque fica negativo e aparece nos alertas). Pode ser desativada.
5. **Controle de estoque do chopp** — por litro vendido; definir se haverá controle por barril/perdas de espuma.
6. **Prazo de reposição e reserva de segurança** — não configurados; a reposição usa 7 dias como referência até serem informados.
7. **Cancelamentos após fechamento do caixa e estornos de fiado pago** — definir o procedimento administrativo.
8. **Código de cancelamento** — implementado como código próprio (separado do código do caixa). Se preferirem usar o mesmo, basta cadastrar o mesmo número nos dois.
10. **Emissão fiscal** — em espera (stand by) por decisão dos proprietários; nenhuma integração foi feita.

## Próxima etapa combinada (ainda não implementada)
- **Contas dos colaboradores pelo administrador:** login no formato `nome.sobrenome`, celular opcional, envio das credenciais pelo WhatsApp, revogar acesso e redefinir senha pelo admin, senha somente com letras. Será tratado junto com a revisão da autenticação principal (hoje a senha exige 8+ caracteres de qualquer tipo).
