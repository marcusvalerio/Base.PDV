/**
 * Desenhos pré-cadastrados de produtos (64×64). Cada variação tem desenho e tamanho próprios,
 * para diferenciar na tela de vender: cerveja lata 350 × garrafa 600 × litrão 1L, maizena × recheado etc.
 * Guardado no produto como image_url = "art:<chave>".
 */
type Art = { label: string; group: string; svg: JSX.Element };

const T = ({ x = 32, y, s = 9, c = '#fff', children }: { x?: number; y: number; s?: number; c?: string; children: string }) => (
  <text x={x} y={y} fontSize={s} fontWeight={800} fill={c} textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">{children}</text>
);

const can = (body: string, band: string, label: string, tall = false, slim = false) => {
  const w = slim ? 16 : 22, x = 32 - w / 2, top = tall ? 6 : 12, h = tall ? 52 : 44;
  return (<>
    <rect x={x} y={top} width={w} height={h} rx={4} fill={body} />
    <rect x={x + 2} y={top - 2} width={w - 4} height={4} rx={2} fill="#c9ccd4" />
    <rect x={x} y={top + h * 0.38} width={w} height={h * 0.28} fill={band} />
    <rect x={x + 3} y={top + 4} width={3} height={h - 8} rx={1.5} fill="#fff" opacity={0.25} />
    <T y={top + h * 0.38 + h * 0.28 / 2 + 3.2} s={slim ? 7 : 8.5} c={band === '#fff' ? body : '#fff'}>{label}</T>
  </>);
};

const bottle = (glass: string, label: string, tag: string, opts: { w: number; neck: number; top: number; labelC?: string; cap?: string }) => {
  const { w, neck, top, labelC = '#f4e7c4', cap = '#c9a227' } = opts;
  const x = 32 - w / 2, sh = top + neck + 6;
  return (<>
    <rect x={30} y={top - 2} width={4} height={3} rx={1} fill={cap} />
    <path d={`M29 ${top + 1}h6v${neck}c0 3 ${w / 2 - 3} 4 ${w / 2 - 3} 9V58a3 3 0 0 1-3 3H${x + 3}a3 3 0 0 1-3-3V${sh + 3}c0-5 ${w / 2 - 3}-6 ${w / 2 - 3}-9z`} fill={glass} />
    <rect x={x + 1.5} y={sh + 14} width={w - 3} height={15} rx={2} fill={labelC} />
    <T y={sh + 24.5} s={w < 16 ? 6.5 : 8} c="#5a3412">{tag}</T>
    <rect x={x + 3} y={sh + 2} width={2.5} height={34} rx={1.2} fill="#fff" opacity={0.22} />
    {label && <title>{label}</title>}
  </>);
};

const pet = (liquid: string, labelC: string, tag: string, big: boolean) => {
  const w = big ? 24 : 18, x = 32 - w / 2, top = big ? 6 : 14;
  return (<>
    <rect x={29} y={top - 3} width={6} height={4} rx={1} fill="#e53935" />
    <path d={`M29.5 ${top + 1}h5v4c0 2 ${w / 2 - 2.5} 3 ${w / 2 - 2.5} 8V59a2 2 0 0 1-2 2H${x + 2}a2 2 0 0 1-2-2V${top + 13}c0-5 ${w / 2 - 2.5}-6 ${w / 2 - 2.5}-8z`} fill={liquid} />
    <rect x={x} y={top + (big ? 22 : 18)} width={w} height={big ? 14 : 12} fill={labelC} />
    <T y={top + (big ? 32 : 26.5)} s={big ? 9 : 7.5}>{tag}</T>
    <rect x={x + 3} y={top + 10} width={2.5} height={big ? 40 : 30} rx={1.2} fill="#fff" opacity={0.3} />
  </>);
};

export const ART: Record<string, Art> = {
  // Cervejas
  'cerveja-lata': { label: 'Cerveja lata 350 ml', group: 'Cervejas', svg: can('#e8b33a', '#fff', '350') },
  'cerveja-latao': { label: 'Cerveja latão 473 ml', group: 'Cervejas', svg: can('#d99a1e', '#fff', '473', true) },
  'cerveja-longneck': { label: 'Cerveja long neck', group: 'Cervejas', svg: bottle('#6b3a12', '', 'LN', { w: 14, neck: 14, top: 10 }) },
  'cerveja-600': { label: 'Cerveja 600 ml', group: 'Cervejas', svg: bottle('#8a4b14', '', '600', { w: 18, neck: 12, top: 6 }) },
  'cerveja-1l': { label: 'Cerveja 1 litro (litrão)', group: 'Cervejas', svg: bottle('#7a3f0e', '', '1L', { w: 24, neck: 10, top: 4, labelC: '#ffd84d' }) },
  // Chopp
  'chopp-copo': { label: 'Copo de chopp', group: 'Chopp', svg: (<>
    <path d="M20 14h24l-3 44H23z" fill="#f2b632" /><path d="M19 10c2-5 8-5 10-3 2-3 8-3 10 0 3-2 7 0 6 4l-1 4H20z" fill="#fff" />
    <path d="M24 22l2 30" stroke="#fff" strokeWidth={2.5} opacity={0.35} strokeLinecap="round" /><circle cx="35" cy="30" r="1.4" fill="#fff" opacity=".7" /><circle cx="31" cy="40" r="1" fill="#fff" opacity=".7" /></>) },
  'chopp-caneca': { label: 'Caneca de chopp', group: 'Chopp', svg: (<>
    <path d="M44 24h5a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5h-5" fill="none" stroke="#c9ccd4" strokeWidth={4} />
    <rect x="14" y="16" width="30" height="42" rx="4" fill="#f2b632" /><path d="M13 14c2-6 9-6 11-3 3-4 10-4 12 0 4-2 9 1 8 5v4H13z" fill="#fff" />
    <path d="M22 26v24M30 26v24M38 26v24" stroke="#fff" strokeWidth={2} opacity={0.35} /></>) },
  'chopp-jarra': { label: 'Jarra de chopp', group: 'Chopp', svg: (<>
    <path d="M46 22h4a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5h-4" fill="none" stroke="#c9ccd4" strokeWidth={4} />
    <path d="M14 14h32l-2 44a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3z" fill="#f2b632" /><path d="M10 14l6-6h28c3 0 4 3 2 6z" fill="#fff" />
    <T y={42} s={9}>1,5L</T></>) },
  'chopp-barril': { label: 'Barril de chopp', group: 'Chopp', svg: (<>
    <rect x="14" y="10" width="36" height="48" rx="6" fill="#b8bec9" /><rect x="14" y="18" width="36" height="4" fill="#8d94a1" /><rect x="14" y="46" width="36" height="4" fill="#8d94a1" />
    <rect x="27" y="5" width="10" height="6" rx="2" fill="#5d6470" /><T y={38} s={10} c="#3a404b">50L</T></>) },
  // Refrigerantes e outras bebidas
  'refri-lata': { label: 'Refrigerante lata 350 ml', group: 'Bebidas', svg: can('#d32f2f', '#fff', '350') },
  'refri-600': { label: 'Refrigerante 600 ml', group: 'Bebidas', svg: pet('#3b1d12', '#d32f2f', '600', false) },
  'refri-2l': { label: 'Refrigerante 2 litros', group: 'Bebidas', svg: pet('#3b1d12', '#d32f2f', '2L', true) },
  'guarana-2l': { label: 'Guaraná 2 litros', group: 'Bebidas', svg: pet('#7a4a12', '#2e7d32', '2L', true) },
  'agua': { label: 'Água 500 ml', group: 'Bebidas', svg: pet('#9fd3f5', '#1e88e5', '500', false) },
  'agua-gas': { label: 'Água com gás', group: 'Bebidas', svg: (<>{pet('#9fd3f5', '#00897b', 'GÁS', false)}<circle cx="28" cy="50" r="1.4" fill="#fff" /><circle cx="35" cy="54" r="1.1" fill="#fff" /><circle cx="31" cy="44" r="1" fill="#fff" /></>) },
  'energetico': { label: 'Energético', group: 'Bebidas', svg: (<>{can('#1d2a6b', '#c6ff00', '⚡', true, true)}</>) },
  'suco': { label: 'Suco de caixinha', group: 'Bebidas', svg: (<>
    <path d="M18 18l4-6h20l4 6v40H18z" fill="#ff9800" /><rect x="18" y="30" width="28" height="14" fill="#fff" /><circle cx="32" cy="37" r="5" fill="#ff9800" />
    <path d="M38 12l4-8" stroke="#e53935" strokeWidth={2.5} strokeLinecap="round" /></>) },
  'dose': { label: 'Dose (cachaça/destilado)', group: 'Bebidas', svg: (<>
    <path d="M20 20h24l-3 36H23z" fill="#dfe7ef" /><path d="M21.5 34h21l-1.8 22H23.3z" fill="#e7c36b" /><path d="M24 24l2 28" stroke="#fff" strokeWidth={2} opacity={0.6} /></>) },
  'gelo': { label: 'Gelo (pacote)', group: 'Bebidas', svg: (<>
    <path d="M14 12h36l-2 46H16z" fill="#d6ecfb" /><rect x="14" y="12" width="36" height="6" fill="#1e88e5" />
    <rect x="22" y="26" width="9" height="9" rx="2" fill="#fff" /><rect x="33" y="32" width="9" height="9" rx="2" fill="#fff" /><rect x="24" y="40" width="9" height="9" rx="2" fill="#fff" /><T y={56} s={7} c="#1e88e5">GELO</T></>) },
  // Biscoitos
  'biscoito-maizena': { label: 'Biscoito maizena', group: 'Biscoitos', svg: (<>
    <circle cx="32" cy="32" r="22" fill="#f3d58e" stroke="#e2bb62" strokeWidth={3} strokeDasharray="3 2.4" />
    <circle cx="32" cy="32" r="16" fill="none" stroke="#e2bb62" strokeWidth={1.2} />
    {[[26, 26], [32, 24], [38, 26], [24, 32], [32, 32], [40, 32], [26, 38], [32, 40], [38, 38]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r={1.3} fill="#c99a3c" />)}</>) },
  'biscoito-recheado': { label: 'Biscoito recheado', group: 'Biscoitos', svg: (<>
    <ellipse cx="32" cy="22" rx="22" ry="7" fill="#4a2a17" /><rect x="10" y="22" width="44" height="7" fill="#4a2a17" />
    <rect x="11" y="29" width="42" height="6" fill="#fff4e0" /><rect x="10" y="35" width="44" height="7" fill="#4a2a17" /><ellipse cx="32" cy="42" rx="22" ry="7" fill="#3a2010" />
    <circle cx="24" cy="21" r="1.5" fill="#6b3f22" /><circle cx="32" cy="19" r="1.5" fill="#6b3f22" /><circle cx="40" cy="21" r="1.5" fill="#6b3f22" /></>) },
  'biscoito-cream-cracker': { label: 'Biscoito cream cracker / água e sal', group: 'Biscoitos', svg: (<>
    <rect x="12" y="12" width="40" height="40" rx="4" fill="#f0d49a" stroke="#dcb56a" strokeWidth={2} />
    {[20, 32, 44].flatMap((x) => [20, 32, 44].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.6} fill="#b98a3e" />))}</>) },
  'biscoito-wafer': { label: 'Wafer', group: 'Biscoitos', svg: (<>
    <rect x="8" y="20" width="48" height="24" rx="3" fill="#e9c27a" /><path d="M8 28h48M8 36h48M16 20v24M24 20v24M32 20v24M40 20v24M48 20v24" stroke="#c99a46" strokeWidth={1.5} /></>) },
  // Doces e salgados
  'salgadinho': { label: 'Salgadinho (pacote)', group: 'Doces e salgados', svg: (<>
    <path d="M14 8h36l-3 6 3 6-2 34 2 4H14l2-4-2-34 3-6z" fill="#ff7a00" /><ellipse cx="32" cy="34" rx="12" ry="9" fill="#ffd34d" />
    <path d="M26 33l4-4 5 6 3-3" stroke="#e05a00" strokeWidth={2} fill="none" strokeLinecap="round" /></>) },
  'chocolate': { label: 'Chocolate (barra)', group: 'Doces e salgados', svg: (<>
    <rect x="12" y="10" width="40" height="44" rx="3" fill="#5b2c16" /><path d="M12 24h40M12 38h40M25 10v44M39 10v44" stroke="#3d1c0d" strokeWidth={2} />
    <path d="M12 38h40v16H12z" fill="#8e24aa" /><T y={50} s={7}>CHOCO</T></>) },
  'bala': { label: 'Bala / doce', group: 'Doces e salgados', svg: (<>
    <path d="M8 22l10 10-10 10zM56 22L46 32l10 10z" fill="#f06292" /><ellipse cx="32" cy="32" rx="15" ry="11" fill="#e91e63" />
    <path d="M24 26c4 2 12 2 16 0" stroke="#fff" strokeWidth={2} opacity={0.5} fill="none" /></>) },
  'porcao-fritas': { label: 'Porção de fritas', group: 'Doces e salgados', svg: (<>
    {[18, 23, 28, 33, 38, 43].map((x, i) => <rect key={x} x={x} y={8 + (i % 3) * 3} width={4} height={26} rx={1.5} fill="#ffd54f" transform={`rotate(${(i - 2.5) * 4} ${x} 34)`} />)}
    <path d="M14 28h36l-4 30H18z" fill="#e53935" /><path d="M24 40c3 4 13 4 16 0" stroke="#fff" strokeWidth={2.5} fill="none" strokeLinecap="round" /></>) },
  'cachorro-quente': { label: 'Cachorro-quente', group: 'Doces e salgados', svg: (<>
    <rect x="6" y="26" width="52" height="12" rx="6" fill="#b5462a" /><path d="M8 32c6-5 12 5 18 0s12 5 18 0 10 3 12 0" stroke="#ffd54f" strokeWidth={2.5} fill="none" />
    <path d="M10 34h44a10 10 0 0 1-10 10H20a10 10 0 0 1-10-10z" fill="#e8b46a" /><path d="M10 30a10 10 0 0 1 10-8h24a10 10 0 0 1 10 8z" fill="#f0c27e" /></>) },
  // Mercearia
  'arroz': { label: 'Arroz (pacote)', group: 'Mercearia', svg: (<>
    <path d="M14 8h36v48a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z" fill="#f5f5f5" stroke="#d6d6d6" /><rect x="14" y="8" width="36" height="8" fill="#1565c0" />
    <rect x="18" y="22" width="28" height="14" rx="2" fill="#1565c0" /><T y={32} s={8}>ARROZ</T><T y={50} s={9} c="#1565c0">5kg</T></>) },
  'feijao': { label: 'Feijão (pacote)', group: 'Mercearia', svg: (<>
    <path d="M14 8h36v48a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z" fill="#f5f5f5" stroke="#d6d6d6" /><rect x="14" y="8" width="36" height="8" fill="#c62828" />
    {[[22, 26], [30, 24], [38, 27], [26, 33], [35, 34]].map(([x, y]) => <ellipse key={`${x}${y}`} cx={x} cy={y} rx={3.5} ry={2.3} fill="#5d2e1a" />)}<T y={50} s={9} c="#c62828">1kg</T></>) },
  'oleo': { label: 'Óleo', group: 'Mercearia', svg: pet('#f6c623', '#2e7d32', '900', true) },
  'carvao': { label: 'Carvão', group: 'Mercearia', svg: (<>
    <path d="M12 10h40l-2 48H14z" fill="#3a3a3a" /><rect x="12" y="10" width="40" height="7" fill="#e65100" />
    <path d="M22 36l4-6 4 5 5-7 6 8" stroke="#ff7043" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" /><T y={52} s={8}>CARVÃO</T></>) },
};

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Escolhe o desenho pelo nome do produto (quando o produto não tem desenho nem foto definidos). */
export function guessArt(name = ''): string | null {
  const n = norm(name);
  const has = (re: RegExp) => re.test(n);
  if (has(/chopp|chope/)) return has(/barril/) ? 'chopp-barril' : has(/caneca/) ? 'chopp-caneca' : has(/jarra/) ? 'chopp-jarra' : 'chopp-copo';
  if (has(/cerveja|brahma|skol|heineken|amstel|budweiser|original|stella|itaipava|corona|antarctica/)) {
    if (has(/473|latao/)) return 'cerveja-latao';
    if (has(/long ?neck|355|330/)) return 'cerveja-longneck';
    if (has(/600/)) return 'cerveja-600';
    if (has(/\b1 ?l\b|1 ?litro|litrao|1000/)) return 'cerveja-1l';
    return 'cerveja-lata';
  }
  if (has(/energ|red ?bull|monster/)) return 'energetico';
  if (has(/agua/)) return has(/gas/) ? 'agua-gas' : 'agua';
  if (has(/refri|coca|guarana|fanta|sprite|pepsi|soda|kuat|tubaina/)) {
    const big = has(/\b2 ?l\b|2 ?litros|2000|1,5|1\.5/);
    if (big) return has(/guarana|kuat/) ? 'guarana-2l' : 'refri-2l';
    if (has(/600|garrafa/)) return 'refri-600';
    return 'refri-lata';
  }
  if (has(/suco|del valle|caixinha/)) return 'suco';
  if (has(/dose|cachaca|pinga|whisky|vodka|conhaque|51\b/)) return 'dose';
  if (has(/gelo/)) return 'gelo';
  if (has(/maizena|maisena|maria\b/)) return 'biscoito-maizena';
  if (has(/cream ?cracker|agua e sal|cracker/)) return 'biscoito-cream-cracker';
  if (has(/wafer/)) return 'biscoito-wafer';
  if (has(/recheado|oreo|negresco|passatempo|trakinas|bono/)) return 'biscoito-recheado';
  if (has(/biscoito|bolacha/)) return 'biscoito-maizena';
  if (has(/frita|batata/)) return 'porcao-fritas';
  if (has(/salgadinho|chips|doritos|ruffles|cheetos|fandangos/)) return 'salgadinho';
  if (has(/chocolate|bombom|kit ?kat|bis\b|lacta/)) return 'chocolate';
  if (has(/bala|chiclete|pirulito|doce/)) return 'bala';
  if (has(/cachorro|hot ?dog/)) return 'cachorro-quente';
  if (has(/arroz/)) return 'arroz';
  if (has(/feijao/)) return 'feijao';
  if (has(/oleo/)) return 'oleo';
  if (has(/carvao/)) return 'carvao';
  return null;
}
