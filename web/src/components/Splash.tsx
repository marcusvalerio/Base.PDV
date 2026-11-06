import { useEffect, useState } from 'react';
import { useSession } from './session';

/**
 * Abertura do app (~3,4 s): caixa aberta com luz, os módulos (Caixa, Produtos, Estoque, Mesas) entram nela,
 * ela fecha, gira até o centro e vira o logo; surge o nome e a saudação com o nome do estabelecimento.
 * Uma vez por abertura (sessão do navegador); toque para pular. Com "reduzir movimento", mostra só o final.
 */
const KEY = 'pdv.splash.seen';
const LENGTH = 3400;
export const splashPending = () => { try { return !sessionStorage.getItem(KEY); } catch { return false; } };

function greeting(d = new Date()) {
  const h = d.getHours();
  return h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite';
}

/** Enquanto o sistema carrega na primeira abertura: o mesmo fundo, sem piscar branco. */
export function SplashLoading() {
  return <div className="op idle"><div className="op-floor" /></div>;
}

const TILES: [string, string][] = [['t1', 'CAIXA'], ['t2', 'PRODUTOS'], ['t3', 'ESTOQUE'], ['t4', 'MESAS']];
const COLORS: Record<string, string> = { t1: '#34d399', t2: '#60a5fa', t3: '#fbbf24', t4: '#f472b6' };

export function Splash() {
  const { boot } = useSession();
  const calm = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [phase, setPhase] = useState<'on' | 'out' | 'off'>(() => (splashPending() ? 'on' : 'off'));
  useEffect(() => {
    if (phase !== 'on') return;
    try { sessionStorage.setItem(KEY, '1'); } catch { /* sem armazenamento: mostra mesmo assim */ }
    const t = setTimeout(() => setPhase('out'), calm ? 1100 : LENGTH + 500);
    return () => clearTimeout(t);
  }, [phase, calm]);
  useEffect(() => {
    if (phase !== 'out') return;
    const t = setTimeout(() => setPhase('off'), 420);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase === 'off') return null;
  return (
    <div className={`op splash ${calm ? 'calm' : ''} ${phase === 'out' ? 'out' : ''}`} role="presentation" onClick={() => setPhase('out')}>
      <div className="op-floor" />
      <div className="op-stage">
        <div className="op-beam" />
        <div className="op-refl" />
        {TILES.map(([k, label]) => <div key={k} className={`op-tile ${k}`} style={{ ['--c' as any]: COLORS[k] }}><i />{label}</div>)}
        <div className="op-mover"><div className="op-cube">
          <div className="op-f op-inside" />
          <div className="op-f op-bottom" />
          <div className="op-f op-back"><div className="op-flap" /></div>
          <div className="op-f op-left"><div className="op-flap" /></div>
          <div className="op-f op-right"><div className="op-flap" /></div>
          <div className="op-f op-front"><div className="op-flap" /></div>
        </div></div>
      </div>
      <div className="op-logo">c.</div>
      <div className="op-name">
        <div className="op-word">Central<b>.</b>PDV</div>
        <div className="op-hi">{greeting()}, <strong>{boot?.storeName || 'bem-vindo'}</strong></div>
      </div>
    </div>
  );
}
