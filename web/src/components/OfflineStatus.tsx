import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, dateTime } from '../lib/format';
import { useOffline, syncOutbox, discardSale, retrySale, ownerOf } from '../lib/offline';
import { useSession } from './session';
import { Modal, useToast } from './ui';

/** Topo da tela: sem internet / vendas guardadas para enviar. Também envia a fila sozinho. */
export function OfflineStatus() {
  const { user } = useSession();
  const owner = ownerOf(user);
  const { online, pending, failed } = useOffline(owner);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const sync = async (manual = false) => {
    const n = await syncOutbox(owner, (body) => api('/sales', { body }));
    if (n > 0) toast(`${n} venda(s) feita(s) sem internet enviada(s).`, 'success');
    else if (manual && !navigator.onLine) toast('Ainda sem internet.', 'error');
  };
  useEffect(() => {
    sync();
    addEventListener('online', () => sync());
    const t = setInterval(() => sync(), 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  if (online && !pending.length && !failed.length) return null;
  return (
    <>
      <button className={`badge ${failed.length ? 'danger' : 'warning'} offline-pill`} onClick={() => setOpen(true)}>
        {!online ? 'Sem internet' : ''}{!online && pending.length ? ' · ' : ''}{pending.length ? `${pending.length} para enviar` : ''}{failed.length ? `${online && !pending.length ? '' : ' · '}${failed.length} com erro` : ''}
      </button>
      {open && (
        <Modal title="Vendas feitas sem internet" onClose={() => setOpen(false)} footer={<button className="btn primary" onClick={() => sync(true)} disabled={!pending.length}>Enviar agora</button>}>
          <div className="faint">{online ? 'Conectado. As vendas são enviadas sozinhas.' : 'Sem internet. Pode continuar vendendo (exceto fiado e mesas); as vendas ficam guardadas neste aparelho.'}</div>
          {[...failed, ...pending].map((s) => (
            <div key={s.key} className="card stack" style={{ gap: 6 }}>
              <div className="row"><b className="num">{money(s.totalCents)}</b><span className="spacer" /><span className="faint">{dateTime(s.at)}</span></div>
              <div className="faint">{s.label}</div>
              {s.error && <div className="notice danger">{s.error}</div>}
              {s.error && <div className="row"><button className="btn sm" onClick={() => retrySale(s.key)}>Tentar de novo</button><span className="spacer" />
                <button className="btn sm danger" onClick={() => window.confirm('Descartar esta venda? Ela não será registrada no sistema.') && discardSale(s.key)}>Descartar</button></div>}
            </div>
          ))}
        </Modal>
      )}
    </>
  );
}
