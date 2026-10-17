import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, type User } from './api';
import LoginPage from './pages/LoginPage';
import AccountPage from './pages/AccountPage';
import CatalogPage from './pages/CatalogPage';
import AppDetailPage from './pages/AppDetailPage';
import MyAppsPage from './pages/MyAppsPage';
import PublishPage from './pages/PublishPage';
import HistoryPage from './pages/HistoryPage';
import AttemptDetailPage from './pages/AttemptDetailPage';
import AdminPage from './pages/AdminPage';

interface AuthCtx {
  user: User | null;
  appsUrlTemplate: string;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="layout">
      <header className="nav">
        <Link to="/" className="brand">
          Vibe<span>Craft</span>Hub
        </Link>
        <nav>
          <NavLink to="/" end>
            Catálogo
          </NavLink>
          {user?.role !== 'user' && <NavLink to="/my-apps">Mis apps</NavLink>}
          {user?.role !== 'user' && <NavLink to="/history">Historial</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
          <NavLink to="/account">Mi cuenta</NavLink>
        </nav>
        <div className="user">
          <span>{user?.email}</span>
          <button
            className="secondary"
            onClick={async () => {
              // navigate siempre: si el logout falla por red, el usuario no se queda trabado
              try {
                await logout();
              } finally {
                navigate('/login');
              }
            }}
          >
            Salir
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [appsUrlTemplate, setAppsUrlTemplate] = useState('http://localhost:3000/bundles/{slug}/');

  useEffect(() => {
    Promise.all([api.me(), api.config().catch(() => null)])
      .then(([me, cfg]) => {
        setUser(me.user);
        if (cfg) setAppsUrlTemplate(cfg.appsUrlTemplate);
      })
      .finally(() => setLoading(false));
  }, []);

  const ctx: AuthCtx = {
    user,
    appsUrlTemplate,
    setUser,
    logout: async () => {
      await api.logout();
      setUser(null);
    },
  };

  if (loading) return <div style={{ padding: 40, color: 'var(--muted)' }}>Cargando…</div>;

  return (
    <Ctx.Provider value={ctx}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <Protected>
              <CatalogPage />
            </Protected>
          }
        />
        <Route
          path="/apps/:slug"
          element={
            <Protected>
              <AppDetailPage />
            </Protected>
          }
        />
        <Route
          path="/my-apps"
          element={
            <Protected>
              <MyAppsPage />
            </Protected>
          }
        />
        <Route
          path="/publish"
          element={
            <Protected>
              <PublishPage />
            </Protected>
          }
        />
        <Route
          path="/history"
          element={
            <Protected>
              <HistoryPage />
            </Protected>
          }
        />
        <Route
          path="/account"
          element={
            <Protected>
              <AccountPage />
            </Protected>
          }
        />
        <Route
          path="/attempts/:id"
          element={
            <Protected>
              <AttemptDetailPage />
            </Protected>
          }
        />
        <Route
          path="/admin"
          element={
            <Protected>
              <AdminPage />
            </Protected>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Ctx.Provider>
  );
}
