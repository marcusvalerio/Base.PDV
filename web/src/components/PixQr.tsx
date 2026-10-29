import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { pixPayload } from '../lib/pix';
import { money } from '../lib/format';
import { useToast } from './ui';

/** QR Code Pix com o valor exato da venda (a chave vem das Configurações da loja). */
export function PixQr({ pix, amountCents, txid }: { pix: { key: string; name: string; city: string }; amountCents: number; txid?: string }) {
  const toast = useToast();
  const code = useMemo(() => pixPayload({ ...pix, amountCents, txid }), [pix, amountCents, txid]);
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(code);
    q.make();
    return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }, [code]);
  const copy = async () => { try { await navigator.clipboard.writeText(code); toast('Pix copia e cola copiado.', 'success'); } catch { toast('Não foi possível copiar.', 'error'); } };
  return (
    <div className="pix-box">
      <div className="pix-qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label={`QR Code Pix de ${money(amountCents)}`} />
      <div className="stack" style={{ gap: 6, minWidth: 0 }}>
        <b>Pix de {money(amountCents)}</b>
        <span className="faint">Peça para o cliente apontar a câmera do app do banco. O valor já vem preenchido.</span>
        <span className="faint">Confira no celular ou na maquininha que o Pix caiu antes de confirmar.</span>
        <button className="btn sm" onClick={copy}>Copiar código (copia e cola)</button>
      </div>
    </div>
  );
}
