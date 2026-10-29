import { useToast } from './ui';

/** Telefone brasileiro para link do WhatsApp (só números, com 55). */
export const waPhone = (phone?: string | null) => {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return '55' + d;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
};

export const waLink = (text: string, phone?: string | null) => `https://wa.me/${waPhone(phone) ?? ''}?text=${encodeURIComponent(text)}`;

/** Botões para enviar um texto: WhatsApp (escolher contato ou direto), compartilhar e copiar. */
export function ShareButtons({ text, title, phone, phoneLabel }: { text: string; title: string; phone?: string | null; phoneLabel?: string }) {
  const toast = useToast();
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;
  const open = (url: string) => window.open(url, '_blank', 'noopener');
  const copy = async () => { try { await navigator.clipboard.writeText(text); toast('Texto copiado.', 'success'); } catch { toast('Não foi possível copiar.', 'error'); } };
  const share = async () => { try { await navigator.share({ title, text }); } catch { /* cancelado */ } };
  return (
    <div className="row wrap">
      <button className="btn wa-btn" onClick={() => open(waLink(text))}>Enviar pelo WhatsApp</button>
      {waPhone(phone) && <button className="btn wa-btn" onClick={() => open(waLink(text, phone))}>Enviar para {phoneLabel ?? phone}</button>}
      {canShare && <button className="btn" onClick={share}>Compartilhar</button>}
      <button className="btn" onClick={copy}>Copiar</button>
    </div>
  );
}
