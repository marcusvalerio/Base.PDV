import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession, type ModuleKey } from './session';

/**
 * Tour guiado do sistema: passa pelas telas destacando cada parte, com texto curto.
 * Pode ser repetido a qualquer momento pelo botão "?" no topo. Na primeira entrada de cada pessoa, começa sozinho.
 */
interface Step { path: string; sel?: string; title: string; text: string; admin?: boolean; mod?: ModuleKey }

const STEPS: Step[] = [
  { path: '/', title: 'Bem-vindo ao Central.PDV', text: 'Este tour mostra cada parte do sistema em 1 minuto. Use "Próximo" para avançar. Dá para repetir quando quiser pelo botão "?" no topo.' },
  { path: '/', sel: '.topbar .nav, .bottom-nav', title: 'Menu principal', text: 'Vender, Mesas, Fiado, Caixa e Inventário. No celular o menu fica embaixo, perto do polegar.' },
  { path: '/', sel: '.pos .input', title: '1. Ache o produto', text: 'Digite o nome ou leia o código de barras com o leitor. No celular, toque em "Câmera" para ler o código pela câmera.' },
  { path: '/', sel: '.pos .chips', title: 'Categorias', text: 'Filtre por categoria para achar mais rápido.' },
  { path: '/', sel: '.pos .tiles', title: '2. Toque para adicionar', text: 'Cada toque soma 1 unidade ao pedido. Produtos vendidos por kg ou litro pedem a quantidade. Borda vermelha = sem estoque; amarela = estoque baixo.' },
  { path: '/', sel: '.pos-cart, .mobile-cart-bar', title: '3. Cobre', text: 'Confira o pedido e toque em "Cobrar". Escolha Dinheiro (o troco é calculado), Pix, Cartão (débito ou crédito) ou Fiado (escolha o cliente).' },
  { path: '/caixa', sel: '.content', title: 'Caixa', text: 'Sem caixa aberto não há vendas. Abra com o dinheiro inicial e o código do caixa. Use Suprimento para colocar dinheiro e Retirada para tirar. No fim do turno, "Fechar caixa": conte a gaveta e confirme.' },
  { path: '/caixa', sel: '.content', title: 'Cancelar uma venda', text: 'Em "Vendas deste caixa", toque na venda para ver os itens, imprimir o comprovante ou cancelar (pede o código de cancelamento e o motivo).' },
  { path: '/mesas', sel: '.content', mod: 'mesas', title: 'Mesas', text: '"Abrir mesa", dê um nome (ex.: Mesa 04) e, se quiser, as pessoas. Lance os itens em cada pessoa. "Fechar conta" cobra uma pessoa; "Fechar mesa inteira" cobra tudo. Lançou errado? "Corrigir" com o código de cancelamento.' },
  { path: '/fiado', sel: '.content', mod: 'fiado', title: 'Fiado', text: 'Lista quem deve e há quanto tempo. "Cobrar" manda um lembrete pelo WhatsApp. Toque no nome do cliente para registrar um pagamento ou gerar o extrato.' },
  { path: '/inventario', sel: '.content', mod: 'inventario', title: 'Inventário', text: 'Conte o estoque: completo, por categoria ou contagem rápida. Leia os códigos, digite as quantidades e conclua para ajustar o estoque.' },
  { path: '/admin', sel: '.metrics', admin: true, title: 'Painel do dono', text: 'Faturamento, vendas, margem e fiado do dia, com comparação ao período anterior. Os alertas coloridos mostram falta de estoque, validade e fiado a receber.' },
  { path: '/admin', sel: '.sidenav', admin: true, title: 'Administração', text: 'Tudo que é gestão fica aqui: Produtos, Estoque, Clientes, Vendas, Caixas, Usuários, Configurações e Assinatura.' },
  { path: '/admin/produtos', sel: '.page-head', admin: true, title: 'Produtos', text: '"Novo produto" cadastra um item; "Produtos prontos" traz um catálogo para marcar e ajustar preço. Em cada produto: "Entrada" (chegou mercadoria), "Editar" e "Histórico".' },
  { path: '/admin/usuarios', sel: '.page-head', admin: true, title: 'Equipe', text: '"Novo usuário" cria o acesso de quem trabalha com você, como Operador (só vende) ou Administrador (vê tudo). A senha pode ser enviada pelo WhatsApp.' },
  { path: '/admin/config', sel: '.content', admin: true, title: 'Configurações', text: 'Nome e logo, impressora, chave Pix (gera QR Code com o valor), código de caixa e de cancelamento, acréscimo de cartão e fiado.' },
  { path: '/', sel: '.help-btn', title: 'Pronto!', text: 'Para repetir o tour ou abrir o manual completo, toque aqui no "?" a qualquer momento.' },
];

const KEY = 'pdv.tour.seen.';
const START = 'pdv:tour';
export const startTour = () => window.dispatchEvent(new Event(START));

function visible(sel?: string): Element | null {
  if (!sel) return null;
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el;
  }
  return null;
}

export function Tour() {
  const { user, boot } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [i, setI] = useState(-1);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const steps = STEPS.filter((s) => (!s.admin || user?.role === 'ADMIN') && (!s.mod || boot?.modules[s.mod]));
  const step = i >= 0 ? steps[i] : null;
  const owner = user ? `${user.tenantId}:${user.id}` : '';

  const close = useCallback(() => { setI(-1); try { localStorage.setItem(KEY + owner, '1'); } catch { /* sem armazenamento */ } }, [owner]);

  useEffect(() => {
    const h = () => setI(0);
    window.addEventListener(START, h);
    return () => window.removeEventListener(START, h);
  }, []);
  // Primeira entrada desta pessoa neste aparelho: começa sozinho.
  useEffect(() => {
    if (!owner || !boot) return;
    let seen = '1';
    try { seen = localStorage.getItem(KEY + owner) || ''; } catch { /* ignorar */ }
    if (!seen) { const t = setTimeout(() => setI(0), 700); return () => clearTimeout(t); }
  }, [owner, boot]);

  useEffect(() => { if (step && loc.pathname !== step.path) nav(step.path); }, [step, loc.pathname, nav]);

  // Acha o elemento da etapa (a tela pode demorar um pouco para carregar) e acompanha rolagem/tamanho.
  useLayoutEffect(() => {
    if (!step) return;
    let alive = true, tries = 0;
    const find = () => {
      if (!alive) return;
      const el = visible(step.sel);
      if (el) {
        const r0 = el.getBoundingClientRect();
        // Celular: o texto fica fixo embaixo, então a parte destacada sobe para o topo da tela.
        if (window.innerWidth < 700) {
          // Abaixo do topo fixo (e do menu de pílulas do admin, que também fica preso no topo).
          const sn = document.querySelector('.sidenav'); const top = (sn && !el.closest('.sidenav') ? sn.getBoundingClientRect().bottom : 56) + 16;
          if (Math.abs(r0.top - top) > 4 && el.closest('.topbar, .bottom-nav, .mobile-cart-bar, .sidenav') == null) window.scrollBy(0, r0.top - top);
        }
        else if (r0.top < 70 || r0.bottom > window.innerHeight - 90) el.scrollIntoView({ block: r0.height > window.innerHeight * 0.6 ? 'start' : 'center' });
        setRect(el.getBoundingClientRect());
      } else if (step.sel && tries++ < 20) { setRect(null); setTimeout(find, 100); return; } else setRect(null);
    };
    setRect(null);
    const t = setTimeout(find, 150);
    const upd = () => { const el = visible(step.sel); setRect(el ? el.getBoundingClientRect() : null); };
    window.addEventListener('resize', upd); window.addEventListener('scroll', upd, true);
    return () => { alive = false; clearTimeout(t); window.removeEventListener('resize', upd); window.removeEventListener('scroll', upd, true); };
  }, [step, loc.pathname]);

  useEffect(() => {
    if (!step) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') setI((n) => (n + 1 < steps.length ? n + 1 : n));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [step, steps.length, close]);

  if (!step) return null;
  const last = i === steps.length - 1;
  const pad = 8;
  // Destaque: limitado à área visível (um bloco grande, como a tela inteira, não cobre o cartão de texto).
  const hl = rect && {
    left: Math.max(6, rect.left - pad), top: Math.max(4, rect.top - pad),
    right: Math.min(window.innerWidth - 6, rect.right + pad), bottom: Math.min(window.innerHeight - 6, rect.bottom + pad),
  };
  const big = hl && hl.bottom - hl.top > window.innerHeight * 0.5;
  const mobile = window.innerWidth < 700;
  const below = hl && !big && hl.bottom + 280 < window.innerHeight;
  const navUp = mobile && hl && hl.top > window.innerHeight - 160;
  const pos: React.CSSProperties = mobile ? { bottom: navUp ? window.innerHeight - hl!.top + 12 : 84 }
    : !hl || big ? { left: '50%', bottom: 96, transform: 'translateX(-50%)' }
    : below ? { top: hl.bottom + 12, left: Math.min(Math.max(12, hl.left), window.innerWidth - 352) }
    : { bottom: window.innerHeight - hl.top + 12, left: Math.min(Math.max(12, hl.left), window.innerWidth - 352) };
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={step.title}>
      {hl ? <div className="tour-spot" style={{ left: hl.left, top: hl.top, width: hl.right - hl.left, height: hl.bottom - hl.top }} />
        : <div className="tour-dim" />}
      <div className="tour-card" ref={card} style={pos}>
        <div className="tour-count">{i + 1} de {steps.length}</div>
        <h2>{step.title}</h2>
        <p>{step.text}</p>
        <div className="tour-actions">
          <button className="btn ghost sm" onClick={close}>{last ? 'Fechar' : 'Pular tour'}</button>
          <span className="spacer" />
          {i > 0 && <button className="btn sm" onClick={() => setI(i - 1)}>Voltar</button>}
          <button className="btn primary sm" onClick={() => (last ? close() : setI(i + 1))}>{last ? 'Concluir' : 'Próximo'}</button>
        </div>
      </div>
    </div>
  );
}

const VIDEO_CAIXA = '/media/tutorial-operador-b44e68bc09.mp4';
const VIDEO_ADMIN = '/media/tutorial-admin-95be052b9d.mp4';

/** Botão "?" do topo: repetir o tour ou abrir o manual. */
export function HelpMenu() {
  const [open, setOpen] = useState(false);
  const { user } = useSession();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="help-wrap" ref={ref}>
      <button className="btn ghost help-btn" aria-label="Ajuda" aria-expanded={open} onClick={() => setOpen(!open)}>?</button>
      {open && (
        <div className="help-menu" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); startTour(); }}><b>Fazer o tour</b><span>Passo a passo pelas telas</span></button>
          <a role="menuitem" href="/manual.html" target="_blank" rel="noopener" onClick={() => setOpen(false)}><b>Manual completo</b><span>Tudo explicado, com exemplos</span></a>
          <a role="menuitem" href={VIDEO_CAIXA} target="_blank" rel="noopener" onClick={() => setOpen(false)}><b>Vídeo do caixa</b><span>Vender, cobrar e fechar o caixa (2 min)</span></a>
          {user?.role === 'ADMIN' && <a role="menuitem" href={VIDEO_ADMIN} target="_blank" rel="noopener" onClick={() => setOpen(false)}><b>Vídeo do administrador</b><span>Produtos, equipe, relatórios (2 min)</span></a>}
        </div>
      )}
    </div>
  );
}
