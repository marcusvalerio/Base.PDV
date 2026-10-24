import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { Loading, ErrorState } from './ui';

/** Exige caixa aberto para operar; senão orienta a abrir. */
export function RegisterGate({ children }: { children: ReactNode }) {
  const { data, loading, error, reload } = useApi<any>('/cash/current');
  if (loading && data === null && !error) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) {
    return (
      <div className="card stack" style={{ maxWidth: 440, margin: '40px auto', textAlign: 'center' }}>
        <h2>O caixa está fechado</h2>
        <p className="muted" style={{ margin: 0 }}>Para registrar vendas e recebimentos, abra o caixa primeiro.</p>
        <Link to="/caixa" className="btn primary lg">Abrir o caixa</Link>
      </div>
    );
  }
  return <>{children}</>;
}
