import { ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './components/session';
import { ToastProvider, Loading } from './components/ui';
import Login from './pages/Login';
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

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const loc = useLocation();
  const inAdmin = loc.pathname.startsWith('/admin');
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Central</span>
        <nav className="nav">
          <NavLink to="/" end>Vender</NavLink>
          <NavLink to="/mesas">Mesas</NavLink>
          <NavLink to="/fiado">Fiado</NavLink>
          <NavLink to="/caixa">Caixa</NavLink>
          {user?.role === 'ADMIN' && <NavLink to="/admin">Administração</NavLink>}
        </nav>
        <span className="spacer" />
        <span className="faint user-name">{user?.name}</span>
        <button className="btn ghost sm" onClick={logout}>Sair</button>
      </header>
      {inAdmin ? children : <main className={`content ${loc.pathname === '/' ? 'has-bar' : ''}`}>{children}</main>}
    </div>
  );
}

function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = useSession();
  if (user?.role !== 'ADMIN') return <Navigate to="/" replace />;
  const links = [['/admin', 'Painel'], ['/admin/analise', 'Análise'], ['/admin/reposicao', 'Reposição'], ['/admin/produtos', 'Produtos'], ['/admin/estoque', 'Estoque'], ['/admin/clientes', 'Clientes'], ['/admin/vendas', 'Vendas'], ['/admin/caixas', 'Caixas'], ['/admin/usuarios', 'Usuários'], ['/admin/config', 'Configurações'], ['/admin/auditoria', 'Auditoria']];
  return (
    <div className="admin-layout">
      <nav className="sidenav">{links.map(([to, l]) => <NavLink key={to} to={to} end={to === '/admin'}>{l}</NavLink>)}</nav>
      <main className="content">{children}</main>
    </div>
  );
}

function Routed() {
  const { user, ready } = useSession();
  if (!ready) return <Loading />;
  if (!user) return <Login />;
  const A = (el: ReactNode) => <AdminLayout>{el}</AdminLayout>;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Pos />} />
        <Route path="/mesas" element={<TabsList />} />
        <Route path="/mesas/:id" element={<TabDetail />} />
        <Route path="/fiado" element={<Fiado />} />
        <Route path="/caixa" element={<Cash />} />
        <Route path="/admin" element={A(<Dashboard />)} />
        <Route path="/admin/analise" element={A(<Analysis />)} />
        <Route path="/admin/reposicao" element={A(<Restock />)} />
        <Route path="/admin/produtos" element={A(<Products />)} />
        <Route path="/admin/estoque" element={A(<Stock />)} />
        <Route path="/admin/clientes" element={A(<Customers />)} />
        <Route path="/admin/vendas" element={A(<Sales />)} />
        <Route path="/admin/caixas" element={A(<Registers />)} />
        <Route path="/admin/usuarios" element={A(<Users />)} />
        <Route path="/admin/config" element={A(<Settings />)} />
        <Route path="/admin/auditoria" element={A(<Audit />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return <BrowserRouter><SessionProvider><ToastProvider><Routed /></ToastProvider></SessionProvider></BrowserRouter>;
}
