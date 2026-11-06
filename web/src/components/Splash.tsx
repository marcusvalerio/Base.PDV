import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSession } from './session';

/**
 * Abertura do app (~3,8 s): caixa escura com luz suave por dentro e reflexo no chão de vidro; os módulos
 * (Caixa, Produtos, Estoque, Mesas) entram nela, ela fecha, gira até o centro e a frente acende como o logo "c.";
 * surge Central.PDV letra a letra e a saudação com o nome do estabelecimento.
 * Uma vez por abertura (sessão do navegador); toque para pular. Com "reduzir movimento", mostra só o final.
 */
const KEY = 'pdv.splash.seen';
const LENGTH = 4100;
const DAY = 'pdv.splash.day';
export const splashPending = () => { try { return !sessionStorage.getItem(KEY); } catch { return false; } };

function greeting(d = new Date()) {
  const h = d.getHours();
  return h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite';
}

/** Enquanto o sistema carrega na primeira abertura: o mesmo fundo, sem piscar branco. */
export function SplashLoading() {
  return <div className="op idle"><div className="op-floor" /></div>;
}

const CARDS = [
  { k: 'c1', c: '#5eead4', label: 'CAIXA', icon: <><rect x="3" y="7" width="18" height="12" rx="2.5"/><path d="M3 11h18M7 15h3"/><path d="M7 7V5h10v2"/></> },
  { k: 'c2', c: '#93c5fd', label: 'PRODUTOS', icon: <><path d="M20.6 13.4 12 22l-9-9V4h9z"/><circle cx="7.5" cy="8.5" r="1.4"/></> },
  { k: 'c3', c: '#fcd34d', label: 'ESTOQUE', icon: <><path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></> },
  { k: 'c4', c: '#f9a8d4', label: 'MESAS', icon: <><path d="M3 9h18M5 9v11M19 9v11M8 13h8"/><path d="M7 5h10"/></> },
];
const DUST: [number, number, number][] = [[-0.16, 0.33, 0.33], [-0.38, 0.54, 0.18], [-0.40, 0.53, 0.02], [-0.06, 0.29, 0.05], [-0.07, 0.70, 0.06], [-0.25, 0.60, 0.47], [0.07, 0.47, 0.49], [-0.41, 0.72, 0.14], [-0.32, 0.31, 0.15], [0.28, 0.35, 0.29], [0.13, 0.45, 0.27], [-0.39, 0.28, 0.10]];

function Cube({ full }: { full: boolean }) {
  return (
    <div className="op-mover"><div className="op-cube">
      {full && <div className="op-f op-inside" />}
      <div className="op-f op-bottom" />
      <div className="op-f op-back" />
      <div className="op-f op-left" />
      <div className="op-f op-right" />
      <div className="op-f op-front">{full && <><div className="op-brand" /><div className="op-mark">c.</div></>}</div>
      {full && <><div className="op-flap bk" /><div className="op-flap lf" /><div className="op-flap rt" /><div className="op-flap fr" /></>}
    </div></div>
  );
}

export function Splash() {
  // Começa na hora em que o app abre, sem esperar o servidor: o sistema carrega por trás.
  // Se a animação terminar antes do carregamento, segura no logo (com indicador) até ficar pronto.
  const { boot, ready } = useSession();
  const [done, setDone] = useState(false);
  // Animação completa na primeira abertura do dia; nas outras do mesmo dia, só o logo e o nome (rápido).
  const [calm] = useState(() => {
    const reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const today = new Date().toDateString();
    let seenToday = false;
    try { seenToday = localStorage.getItem(DAY) === today; localStorage.setItem(DAY, today); } catch { /* sem armazenamento */ }
    return reduce || seenToday;
  });
  const [phase, setPhase] = useState<'on' | 'out' | 'off'>(() => (splashPending() ? 'on' : 'off'));
  useEffect(() => {
    if (phase !== 'on') return;
    try { sessionStorage.setItem(KEY, '1'); } catch { /* sem armazenamento: mostra mesmo assim */ }
    const t = setTimeout(() => setDone(true), calm ? 900 : LENGTH + 250);
    return () => clearTimeout(t);
  }, [phase, calm]);
  useEffect(() => { if (done && ready && phase === 'on') setPhase('out'); }, [done, ready, phase]);
  useEffect(() => {
    if (phase !== 'out') return;
    const t = setTimeout(() => setPhase('off'), 450);
    return () => clearTimeout(t);
  }, [phase]);
  // A caixa termina exatamente no ponto de "Central.PDV": mede onde o ponto ficou nesta tela.
  const root = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), slot = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (phase === 'off') return;
    const place = () => {
      const r = root.current, st = stage.current, sl = slot.current;
      const cube = r?.querySelector<HTMLElement>(':scope > .op-stage > .op-mover');
      if (!r || !st || !sl || !cube) return;
      const a = st.getBoundingClientRect(), b = sl.getBoundingClientRect(), S = cube.offsetWidth;
      r.style.setProperty('--dx', `${b.left + b.width / 2 - a.left}px`);
      r.style.setProperty('--dy', `${b.top + b.height / 2 - a.top + S / 2}px`);
      r.style.setProperty('--ds', String(b.width / S));
    };
    place();
    document.fonts?.ready.then(place).catch(() => {});
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [phase]);
  if (phase === 'off') return null;
  return (
    <div ref={root} className={`op splash ${calm ? 'calm' : ''} ${phase === 'out' ? 'out' : ''}`} role="presentation" onClick={() => setDone(true)}>
      <div className="op-floor" />
      <div className="op-stage" ref={stage}>
        <div className="op-pool" />
        <div className="op-light" />
        <div className="op-mirror"><Cube full={false} /></div>
        <Cube full />
        {DUST.map(([x, o, d], i) => <i key={i} className="op-dust" style={{ ['--x' as any]: `calc(var(--S) * ${x})`, ['--o' as any]: o, animationDelay: `${d}s` }} />)}
        {CARDS.map((c) => (
          <div key={c.k} className={`op-card ${c.k}`} style={{ ['--c' as any]: c.c }}>
            <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{c.icon}</svg>{c.label}</div>
          </div>
        ))}
      </div>
      <div className="op-name">
        <div className="op-word">
          {[...'Central'].map((ch, i) => <span key={'a' + i} style={{ animationDelay: `calc(var(--T) * .64 + ${(i * 0.04).toFixed(2)}s)` }}>{ch}</span>)}
          <i className="op-slot" ref={slot} />
          {[...'PDV'].map((ch, i) => <span key={'b' + i} style={{ animationDelay: `calc(var(--T) * .83 + ${(i * 0.05).toFixed(2)}s)` }}>{ch}</span>)}
        </div>
        {done && !ready && <div className="op-wait" aria-label="Carregando"><i /><i /><i /></div>}
        <div className="op-hi">{greeting()}, <strong>{boot?.storeName || 'bem-vindo'}</strong></div>
      </div>
    </div>
  );
}
