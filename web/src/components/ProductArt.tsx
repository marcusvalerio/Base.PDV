import { useState } from 'react';

/** Ilustrações simples por categoria (traço), usadas quando o produto não tem foto. */
const ICONS: Record<string, JSX.Element> = {
  cerveja: <><path d="M14 18h22v30a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z" /><path d="M36 24h5a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-5" /><path d="M14 18c0-5 4-8 8-7 2-3 8-4 11 0 3-1 6 2 5 6" /><path d="M21 28v16M29 28v16" /></>,
  chopp: <><path d="M16 12h20l-3 38H19z" /><path d="M16.8 22h18.4" /><path d="M22 32v10M30 32v10" /></>,
  refrigerante: <><rect x="17" y="12" width="18" height="38" rx="5" /><path d="M20 12v-3h12v3M17 22h18M17 40h18" /></>,
  bebida: <><path d="M22 8h8v8l4 6v26a3 3 0 0 1-3 3H21a3 3 0 0 1-3-3V22l4-6z" /><path d="M18 30h16" /></>,
  biscoito: <><circle cx="26" cy="30" r="16" /><circle cx="20" cy="25" r="1.6" /><circle cx="30" cy="23" r="1.6" /><circle cx="25" cy="33" r="1.6" /><circle cx="33" cy="34" r="1.6" /><circle cx="19" cy="37" r="1.6" /></>,
  alimento: <><path d="M8 32h36a18 18 0 0 1-36 0z" /><path d="M18 26c0-4 3-4 3-8M26 26c0-4 3-4 3-8M34 26c0-4 3-4 3-8" /></>,
  mercearia: <><path d="M12 20h28l-2 30H14z" /><path d="M19 20v-4a7 7 0 0 1 14 0v4" /></>,
  outro: <><rect x="12" y="16" width="28" height="30" rx="3" /><path d="M12 24h28M22 16v8M30 16v8" /></>,
};

function iconFor(category = '') {
  const c = category.toLowerCase();
  if (c.includes('chopp')) return ICONS.chopp;
  if (c.includes('cerve')) return ICONS.cerveja;
  if (c.includes('refri')) return ICONS.refrigerante;
  if (c.includes('bebida')) return ICONS.bebida;
  if (c.includes('biscoit')) return ICONS.biscoito;
  if (c.includes('aliment') || c.includes('porç') || c.includes('salgad')) return ICONS.alimento;
  if (c.includes('mercea')) return ICONS.mercearia;
  return ICONS.outro;
}

export function ProductArt({ image, category, size = 'md' }: { image?: string | null; category?: string; size?: 'sm' | 'md' }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`product-art ${size}`} aria-hidden="true">
      {image && !broken
        ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : <svg viewBox="0 0 52 60" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{iconFor(category)}</svg>}
    </div>
  );
}
