import { useEffect, useState } from 'react';
import { useSession } from './session';

/**
 * Abertura do app: marca Central.PDV → saudação com o nome (e a logo) do estabelecimento → abre o sistema.
 * Aparece uma vez por abertura (sessão do navegador), cerca de 1,6 s; toque para pular.
 * Com "reduzir movimento" ligado no aparelho, fica estática e mais curta.
 */
const KEY = 'pdv.splash.seen';
export const splashActive = () => !!document.querySelector('.splash');
export const splashPending = () => { try { return !sessionStorage.getItem(KEY); } catch { return false; } };

function greeting(d = new Date()) {
  const h = d.getHours();
  return h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite';
}

// A tela de carregamento já mostrou a marca: a abertura continua dali, sem recomeçar a animação.
let warm = false;
export function SplashLoading() {
  warm = true;
  return <div className="splash"><div className="splash-glow" /><div className="splash-brand">Central<span>.</span>PDV</div></div>;
}

export function Splash() {
  const { boot } = useSession();
  const [phase, setPhase] = useState<'on' | 'out' | 'off'>(() => {
    try { return sessionStorage.getItem(KEY) ? 'off' : 'on'; } catch { return 'on'; }
  });
  useEffect(() => {
    if (phase !== 'on') return;
    try { sessionStorage.setItem(KEY, '1'); } catch { /* sem armazenamento: mostra mesmo assim */ }
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => setPhase('out'), calm ? 900 : 1700);
    return () => clearTimeout(t);
  }, [phase]);
  useEffect(() => {
    if (phase !== 'out') return;
    const t = setTimeout(() => setPhase('off'), 420);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase === 'off') return null;
  const name = boot?.storeName || 'seu estabelecimento';
  return (
    <div className={`splash ${warm ? 'warm' : ''} ${phase === 'out' ? 'out' : ''}`} role="presentation" onClick={() => setPhase('out')}>
      <div className="splash-glow" />
      <div className="splash-brand">Central<span>.</span>PDV</div>
      <div className="splash-hello">
        {boot?.storeLogo && <img src={boot.storeLogo} alt="" />}
        <span className="g">{greeting()},</span>
        <span className="n">{name}</span>
      </div>
      <div className="splash-bar"><i /></div>
    </div>
  );
}
