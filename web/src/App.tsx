import { ReactNode, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './components/session';
import { ToastProvider, Loading } from './components/ui';
import Login from './pages/Login';
import Onboarding, { onboardingSkipped } from './pages/Onboarding';
import { BillingPage, Blocked } from './pages/Billing';
import Central from './pages/central/Central';
import Pos from './pages/Pos';
import { TabsList, TabDetail } from './pages/Tabs';
import Fiado from './pages/Fiado';
import Cash from './pages/Cash';
import Dashboard from './pages/admin/Dashboard';
import Analysis from './pages/admin/Analysis';
import Restock from './pages/admin/Restock';
import Products from './pages/admin/Products';
import Stock from './pages/admin/Stock';
import { Customers, Sales, Registers, Users, Settings, Audit } from './pages/admin/Admin';
import { InventoryList, InventoryCount } from './pages/Inventory';
import type { ModuleKey } from './components/session';
import { SystemFooter } from './components/SystemFooter';
import { OfflineStatus } from './components/OfflineStatus';

function Shell({ children }: { children: ReactNode }) {
  const { user, logout, boot } = useSession();
  const on = (k: ModuleKey) => !!boot?.modules[k];
  const loc = useLocation();
  const inAdmin = loc.pathname.startsWith('/admin');
  const links: [string, string][] = [['/', 'Vender'], ...(on('mesas') ? [['/mesas', 'Mesas'] as [string, string]] : []), ...(on('fiado') ? [['/fiado', 'Fiado'] as [string, string]] : []),
    ['/caixa', 'Caixa'], ...(on('inventario') ? [['/inventario', 'Inventário'] as [string, string]] : []), ...(user?.role === 'ADMIN' ? [['/admin', 'Admin'] as [string, string]] : [])];
  return (
    <div className="shell">
      <header className="topbar">
        {boot?.storeLogo && <img className="store-logo" src={boot.storeLogo} alt="" />}<span className="brand" title={boot?.storeName || undefined}>{boot?.storeName || 'Meu estabelecimento'}</span>
        <nav className="nav">
          <NavLink to="/" end>Vender</NavLink>
          {on('mesas') && <NavLink to="/mesas">Mesas</NavLink>}
          {on('fiado') && <NavLink to="/fiado">Fiado</NavLink>}
          <NavLink to="/caixa">Caixa</NavLink>
          {on('inventario') && <NavLink to="/inventario">Inventário</NavLink>}
          {user?.role === 'ADMIN' && <NavLink to="/admin">Administração</NavLink>}
        </nav>
        <span className="spacer" />
        <OfflineStatus />
        <span className="faint user-name">{user?.name}</span>
        <button className="btn ghost sm" onClick={logout}>Sair</button>
      </header>
      {inAdmin ? children : <main className={`content ${loc.pathname === '/' ? 'has-bar' : ''}`}>{children}</main>}
      {loc.pathname !== '/' && <SystemFooter />}
      <nav className="bottom-nav" aria-label="Navegação principal">
        {links.map(([to, l]) => <NavLink key={to} to={to} end={to === '/'}>{l}</NavLink>)}
      </nav>
    </div>
  );
}

function AdminLayout({ children }: { children: ReactNode }) {
  const { user, boot } = useSession();
  if (user?.role !== 'ADMIN') return <Navigate to="/" replace />;
  const all: [string, string, ModuleKey?][] = [['/admin', 'Painel'], ['/admin/analise', 'Análise', 'analise'], ['/admin/reposicao', 'Reposição', 'reposicao'], ['/admin/produtos', 'Produtos'], ['/admin/estoque', 'Estoque', 'estoque'], ['/inventario', 'Inventário', 'inventario'], ['/admin/clientes', 'Clientes', 'fiado'], ['/admin/vendas', 'Vendas'], ['/admin/caixas', 'Caixas'], ['/admin/usuarios', 'Usuários'], ['/admin/config', 'Configurações'], ['/admin/auditoria', 'Auditoria', 'auditoria']];
  const links = all.filter(([, , m]) => !m || boot?.modules[m]);
  links.push(['/admin/assinatura', 'Assinatura']);
  return (
    <div className="admin-layout">
      <nav className="sidenav">{links.map(([to, l]) => <NavLink key={to} to={to} end={to === '/admin'}>{l}</NavLink>)}</nav>
      <main className="content">{children}</main>
    </div>
  );
}

/** Rota de módulo: se o super admin não liberou, mostra aviso em vez da tela. */
function M({ k, children }: { k: ModuleKey; children: ReactNode }) {
  const { boot } = useSession();
  if (!boot?.modules[k]) return <div className="card stack" style={{ maxWidth: 460, margin: '40px auto', textAlign: 'center' }}><h2>Módulo não liberado</h2><p className="muted" style={{ margin: 0 }}>Peça ao super administrador para liberar este recurso.</p></div>;
  return <>{children}</>;
}

function Routed() {
  const { user, ready, boot, access } = useSession();
  const [onbDone, setOnbDone] = useState(false);
  if (!ready) return <Loading />;
  if (!user) return <Login />;
  if (access && !access.ok) return user.role === 'ADMIN' && location.pathname === '/admin/assinatura' ? <main className="content"><BillingPage /></main> : <Blocked />;
  if (user.role === 'ADMIN' && boot && !boot.storeName && !onbDone && !onboardingSkipped()) return <Onboarding onDone={() => setOnbDone(true)} />;
  const A = (el: ReactNode) => <AdminLayout>{el}</AdminLayout>;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Pos />} />
        <Route path="/mesas" element={<M k="mesas"><TabsList /></M>} />
        <Route path="/mesas/:id" element={<M k="mesas"><TabDetail /></M>} />
        <Route path="/fiado" element={<M k="fiado"><Fiado /></M>} />
        <Route path="/inventario" element={<M k="inventario"><InventoryList /></M>} />
        <Route path="/inventario/:id" element={<M k="inventario"><InventoryCount /></M>} />
        <Route path="/caixa" element={<Cash />} />
        <Route path="/admin" element={A(<Dashboard />)} />
        <Route path="/admin/analise" element={A(<M k="analise"><Analysis /></M>)} />
        <Route path="/admin/reposicao" element={A(<M k="reposicao"><Restock /></M>)} />
        <Route path="/admin/produtos" element={A(<Products />)} />
        <Route path="/admin/estoque" element={A(<M k="estoque"><Stock /></M>)} />
        <Route path="/admin/clientes" element={A(<M k="fiado"><Customers /></M>)} />
        <Route path="/admin/vendas" element={A(<Sales />)} />
        <Route path="/admin/caixas" element={A(<Registers />)} />
        <Route path="/admin/usuarios" element={A(<Users />)} />
        <Route path="/admin/config" element={A(<Settings />)} />
        <Route path="/admin/auditoria" element={A(<M k="auditoria"><Audit /></M>)} />
        <Route path="/admin/assinatura" element={A(<BillingPage />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  // Painel do administrador central: área separada, com login próprio.
  if (location.pathname.startsWith('/central')) return <BrowserRouter><ToastProvider><Central /></ToastProvider></BrowserRouter>;
  return <BrowserRouter><SessionProvider><ToastProvider><Routed /></ToastProvider></SessionProvider></BrowserRouter>;
}
