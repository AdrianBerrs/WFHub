import { useEffect, useState } from "react";
import { MemoryRouter, Routes, Route, NavLink, useNavigate, Navigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import MarketPage from "./pages/MarketPage";
import FarmAdvisorPage from "./pages/FarmAdvisorPage";
import QuickSearchPage from "./pages/QuickSearchPage";
import BuildAnalyzerPage from "./pages/BuildAnalyzerPage";
import InventoryPage from "./pages/InventoryPage";
import ForjaPage from "./pages/ForjaPage";
import PrimeTrackerPage from "./pages/PrimeTrackerPage";
import BuildTrackerPage from "./pages/BuildTrackerPage";
import RivenAdvisorPage from "./pages/RivenAdvisorPage";
import SettingsPage from "./pages/SettingsPage";
import HubPage from "./pages/HubPage";
import ArbitrationSchedulePage from "./pages/ArbitrationSchedulePage";
import VoidTraderInventoryPage from "./pages/VoidTraderInventoryPage";

const NAV_ITEMS = [
  { to: "/hub", icon: "🛰️", label: "Hub" },
  { to: "/quick-search", icon: "⚡", label: "Busca Rápida" },
  { to: "/market", icon: "💰", label: "Market" },
  { to: "/farm", icon: "🌿", label: "Farm Advisor" },
  { to: "/build-analyzer", icon: "🔍", label: "Build Analyzer" },
  { to: "/build-tracker", icon: "🗂️", label: "Build Tracker" },
  { to: "/prime-tracker", icon: "👑", label: "Prime Tracker" },
  { to: "/inventory", icon: "📦", label: "Inventário" },
  { to: "/riven", icon: "⚔️", label: "Rivens" },
  { to: "/forja", icon: "⚗️", label: "Forja" },
  { to: "/settings", icon: "⚙️", label: "Configurações" },
];

function AppContent() {
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [autoSearch, setAutoSearch] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ name: string }>("item-search-requested", (event) => {
      setAutoSearch(event.payload.name);
      navigate("/quick-search");
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [navigate]);

  return (
      <div className="flex h-screen bg-gray-950 text-gray-100 font-sans">
        {/* Sidebar */}
        <aside
          className="bg-gray-900 border-r border-gray-800 flex flex-col pt-4 overflow-hidden shrink-0"
          style={{ width: sidebarOpen ? "180px" : "48px", transition: "width 200ms ease" }}
        >
          {/* Logo + Toggle */}
          <div className={`flex items-center mb-2 px-2 ${sidebarOpen ? "justify-between" : "justify-center"}`}>
            {sidebarOpen && (
              <span className="text-base font-bold text-purple-400 tracking-wide pl-1">WFHub</span>
            )}
            <button
              onClick={() => setSidebarOpen((o) => !o)}
              className="rounded-md p-1 text-gray-400 hover:text-gray-100 hover:bg-gray-800 text-sm leading-none"
              title={sidebarOpen ? "Recolher" : "Expandir"}
            >
              {sidebarOpen ? "‹" : "›"}
            </button>
          </div>

          {/* Nav */}
          <div className="flex flex-col gap-1 mt-2">
            {NAV_ITEMS.map(({ to, icon, label }) => (
              <NavLink
                key={to}
                to={to}
                title={!sidebarOpen ? label : undefined}
                className={({ isActive }) =>
                  `flex items-center gap-2 py-2 mx-1 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                    sidebarOpen ? "px-3" : "justify-center px-0"
                  } ${
                    isActive
                      ? "bg-purple-500/20 text-purple-400"
                      : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"
                  }`
                }
              >
                <span className="text-base shrink-0">{icon}</span>
                {sidebarOpen && <span>{label}</span>}
              </NavLink>
            ))}
          </div>

          <div className="flex-1" />
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/hub" element={<HubPage />} />
            <Route path="/quick-search" element={
              <QuickSearchPage autoSearch={autoSearch} onAutoSearchDone={() => setAutoSearch(null)} />
            } />
            <Route path="/market" element={
              <MarketPage autoSearch={autoSearch} onAutoSearchDone={() => setAutoSearch(null)} />
            } />
            <Route path="/farm" element={
              <FarmAdvisorPage autoSearch={autoSearch} onAutoSearchDone={() => setAutoSearch(null)} />
            } />
            <Route path="/build-analyzer" element={<BuildAnalyzerPage />} />
            <Route path="/build-tracker" element={<BuildTrackerPage />} />
            <Route path="/riven" element={<RivenAdvisorPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/prime-tracker" element={<PrimeTrackerPage />} />
            <Route path="/forja" element={<ForjaPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/hub/arbitrations" element={<ArbitrationSchedulePage />} />
            <Route path="/hub/void-trader" element={<VoidTraderInventoryPage />} />
            <Route path="*" element={<Navigate to="/hub" replace />} />
          </Routes>
        </main>
      </div>
  );
}

export default function App() {
  return (
    <MemoryRouter initialEntries={["/hub"]}>
      <AppContent />
    </MemoryRouter>
  );
}
