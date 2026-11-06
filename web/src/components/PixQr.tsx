import { useEffect, useMemo, useRef, useState } from 'react';
import { api, newKey } from '../lib/api';
import qrcode from 'qrcode-generator';
import { pixPayload } from '../lib/pix';
import { money } from '../lib/format';
import { useToast } from './ui';

/** Desenha o QR Code de um código Pix (copia e cola). */
function useQrSvg(code: string | null) {
  return useMemo(() => {
    if (!code) return '';
    const q = qrcode(0, 'M'); q.addData(code); q.make();
    return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }, [code]);
}

type Charge = { id: number; status: 'PENDING' | 'APPROVED' | 'CANCELLED' | 'EXPIRED' | 'FAILED'; qrCode: string | null; amountCents: number };

/**
 * Pix automático (plano Pro): gera a cobrança na conta do Mercado Pago do estabelecimento e espera o pagamento.
 * A confirmação vem do servidor, que consulta o Mercado Pago. Quando aprova, chama onPaid (a venda é registrada).
 * Se o caixa sair desta tela sem pagamento, a cobrança é cancelada.
 */
export function PixAuto({ amountCents, onPaid, onFallback }: { amountCents: number; onPaid: (chargeId: number) => void; onFallback: () => void }) {
  const toast = useToast();
  const [c, setC] = useState<Charge | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const paid = useRef(false);
  const svg = useQrSvg(c?.qrCode ?? null);

  useEffect(() => {
    let alive = true, cur: Charge | null = null, timer: any;
    setC(null); setErr(null);
    api<Charge>('/pix/charges', { body: { amountCents, idempotencyKey: newKey() } }).then((ch) => {
      if (!alive) { api(`/pix/charges/${ch.id}/cancel`, { body: {} }).catch(() => {}); return; }
      cur = ch; setC(ch);
      const poll = async () => {
        if (!alive) return;
        try {
          const s = await api<Charge>(`/pix/charges/${ch.id}`);
          cur = s; setC((old) => ({ ...(old ?? s), status: s.status }));
          if (s.status === 'APPROVED') { if (!paid.current) { paid.current = true; onPaid(ch.id); } return; }
          if (s.status !== 'PENDING') return;
        } catch { /* sem conexão: tenta de novo */ }
        timer = setTimeout(poll, 2500);
      };
      timer = setTimeout(poll, 2500);
    }, (e) => alive && setErr(e.message));
    return () => {
      alive = false; clearTimeout(timer);
      if (cur && cur.status === 'PENDING' && !paid.current) api(`/pix/charges/${cur.id}/cancel`, { body: {} }).catch(() => {});
    };
  }, [amountCents, round]);

  const copy = async () => { try { await navigator.clipboard.writeText(c!.qrCode!); toast('Pix copia e cola copiado.', 'success'); } catch { toast('Não foi possível copiar.', 'error'); } };
  if (err) return (
    <div className="notice danger stack" style={{ gap: 8 }}>
      <span>{err}</span>
      <div className="row wrap"><button className="btn sm" onClick={() => setRound(round + 1)}>Tentar de novo</button><button className="btn sm" onClick={onFallback}>Usar Pix pela chave</button></div>
    </div>
  );
  if (!c) return <div className="pix-box"><div className="spinner" /> <span className="muted">Gerando o QR Code no Mercado Pago…</span></div>;
  const ended = c.status === 'EXPIRED' || c.status === 'CANCELLED' || c.status === 'FAILED';
  return (
    <div className={`pix-box ${c.status === 'APPROVED' ? 'pix-paid' : ''}`}>
      {c.status === 'APPROVED'
        ? <div className="pix-qr pix-ok" aria-hidden>✓</div>
        : <div className="pix-qr" style={{ opacity: ended ? 0.25 : 1 }} dangerouslySetInnerHTML={{ __html: svg }} aria-label={`QR Code Pix de ${money(amountCents)}`} />}
      <div className="stack" style={{ gap: 6, minWidth: 0 }}>
        <b>Pix de {money(amountCents)}</b>
        {c.status === 'PENDING' && <><span className="row" style={{ gap: 8 }}><span className="spinner" /><span>Aguardando pagamento…</span></span>
          <span className="faint">A venda confirma sozinha quando o Pix cair. Não precisa conferir no banco.</span>
          <button className="btn sm" onClick={copy}>Copiar código (copia e cola)</button></>}
        {c.status === 'APPROVED' && <><b style={{ color: 'var(--success)' }}>Pagamento confirmado pelo Mercado Pago.</b>
          {/* Se o registro da venda falhar (ex.: queda de conexão), dá para tentar de novo: o Pix pago continua valendo para esta venda. */}
          <button className="btn primary sm" onClick={() => onPaid(c.id)}>Registrar a venda</button></>}
        {ended && <><span className="error-text">{c.status === 'EXPIRED' ? 'O QR Code venceu.' : c.status === 'FAILED' ? 'O pagamento não foi aprovado.' : 'Cobrança cancelada.'}</span>
          <button className="btn sm" onClick={() => setRound(round + 1)}>Gerar outro QR Code</button></>}
        {c.status !== 'APPROVED' && <button className="btn ghost sm" style={{ whiteSpace: "normal", height: "auto", minHeight: 32, textAlign: "left" }} onClick={onFallback}>Usar Pix pela chave (conferência manual)</button>}
      </div>
    </div>
  );
}

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
