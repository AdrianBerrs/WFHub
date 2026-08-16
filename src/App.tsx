import { useState } from "react";
import { MemoryRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Compass,
  DollarSign,
  FolderOpen,
  Package,
  Settings,
  Sprout,
  Swords,
} from "lucide-react";
import MarketPage from "./pages/MarketPage";
import FarmAdvisorPage from "./pages/FarmAdvisorPage";
import BuildAnalyzerPage from "./pages/BuildAnalyzerPage";
import InventoryPage from "./pages/InventoryPage";
import BuildTrackerPage from "./pages/BuildTrackerPage";
import MyOrdersPage from "./pages/MyOrdersPage";
import RivenAdvisorPage from "./pages/RivenAdvisorPage";
import SettingsPage from "./pages/SettingsPage";
import HubPage from "./pages/HubPage";
import ArbitrationSchedulePage from "./pages/ArbitrationSchedulePage";
import VoidTraderInventoryPage from "./pages/VoidTraderInventoryPage";
import WeeklyPage from "./pages/WeeklyPage";

const NAV_ITEMS = [
  { to: "/hub", icon: Compass, label: "World State", color: "text-cyan-400" },
  { to: "/weekly", icon: CalendarDays, label: "Weekly", color: "text-violet-400" },
  { to: "/market", icon: DollarSign, label: "Market", color: "text-emerald-400" },
  { to: "/farm", icon: Sprout, label: "Farm Advisor", color: "text-green-400" },
  { to: "/build-tracker", icon: FolderOpen, label: "Builds", color: "text-amber-400" },
  { to: "/inventory", icon: Package, label: "Inventory", color: "text-indigo-400" },
  { to: "/riven", icon: Swords, label: "Riven", color: "text-rose-400" },
];

function AppContent() {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
      <div className="flex h-screen w-screen overflow-hidden bg-[#07070a] text-slate-200 font-sans antialiased">
        <aside
          className="relative h-screen shrink-0 bg-[#0d0d12] border-r border-[#1e1e2d] flex flex-col overflow-hidden transition-[width] duration-300"
          style={{ width: sidebarOpen ? "256px" : "80px" }}
        >
          {sidebarOpen ? (
            <div className="flex items-center border-b border-[#1e1e2d] p-5">
              <div className="flex items-center gap-3 overflow-hidden">
                <div className="flex h-9 min-w-9 items-center justify-center rounded-lg bg-gradient-to-tr from-cyan-500 to-purple-600 text-base font-black text-white shadow-[0_0_12px_rgba(6,182,212,0.35)]">
                  WF
                </div>
                <div className="flex flex-col whitespace-nowrap">
                  <span className="text-sm font-bold tracking-wide text-slate-100">WFHUB</span>
                  <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-cyan-400">
                    YOUR WF TRACKER
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center border-b border-[#1e1e2d] py-4">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-tr from-cyan-500 to-purple-600 text-base font-black text-white shadow-[0_0_12px_rgba(6,182,212,0.35)]">
                WF
              </div>
            </div>
          )}

          <div className="custom-scrollbar flex-1 space-y-1.5 overflow-y-auto px-3 py-6">
            {NAV_ITEMS.map(({ to, icon: Icon, label, color }) => (
                <NavLink
                  key={to}
                  to={to}
                  title={!sidebarOpen ? label : undefined}
                  className={({ isActive }) =>
                      `group relative flex w-full items-center gap-3.5 rounded-lg border px-4 py-3 text-left transition-all ${
                        sidebarOpen ? "" : "justify-center px-0"
                      } ${
                        isActive
                          ? "border-cyan-500/20 bg-gradient-to-r from-cyan-950/40 to-slate-900/40 text-cyan-400 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]"
                          : "border-transparent text-slate-400 hover:bg-slate-900/30 hover:text-slate-100"
                      }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute bottom-1/4 left-0 top-1/4 w-[3px] rounded-r-md bg-gradient-to-b from-cyan-400 to-purple-500 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                      )}
                      <Icon
                        size={18}
                        className={`shrink-0 transition-colors ${
                          isActive ? "text-cyan-400" : `${color} opacity-80 group-hover:opacity-100`
                        }`}
                      />
                      {sidebarOpen && <span className="text-xs font-semibold tracking-wide">{label}</span>}
                      {!sidebarOpen && (
                        <span className="absolute left-20 z-50 hidden whitespace-nowrap rounded border border-slate-800 bg-[#12121a] px-3 py-1.5 text-[11px] font-bold text-slate-100 shadow-xl group-hover:flex">
                          {label}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
            ))}
          </div>

          <div className="flex items-center gap-2 p-3">
            {sidebarOpen && (
              <NavLink
                to="/settings"
                title="Settings"
                className={({ isActive }) =>
                  `flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    isActive
                      ? "bg-cyan-950/40 text-cyan-400"
                      : "text-slate-400 hover:bg-slate-900/30 hover:text-white"
                  }`
                }
              >
                <Settings size={16} />
              </NavLink>
            )}
            <button
              onClick={() => setSidebarOpen((o) => !o)}
              className={`flex h-9 min-w-0 flex-1 items-center rounded-lg px-3 text-xs font-bold text-slate-400 transition-colors hover:text-white ${
                sidebarOpen ? "justify-end" : "justify-center"
              }`}
              title={sidebarOpen ? "Collapse" : "Expand"}
            >
              {sidebarOpen }
              {sidebarOpen ? <><ChevronLeft size={14} /><ChevronLeft size={14} /><ChevronLeft size={14} /></> : <><ChevronRight size={14} /><ChevronRight size={14} /><ChevronRight size={14} /></>}
            </button>
          </div>
        </aside>

        <div className="relative flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
          <div className="pointer-events-none absolute right-[20%] top-0 z-0 h-[450px] w-[450px] rounded-full bg-gradient-to-br from-cyan-500/5 to-purple-600/5 blur-[120px]" />
          <div className="pointer-events-none absolute bottom-[10%] left-[10%] z-0 h-[350px] w-[350px] rounded-full bg-gradient-to-tr from-rose-500/5 to-transparent blur-[100px]" />

          <main className="custom-scrollbar z-10 min-h-0 flex-1 overflow-y-auto">
            <Routes>
              <Route path="/hub" element={<HubPage />} />
              <Route path="/weekly" element={<WeeklyPage />} />
              <Route path="/market" element={<MarketPage />} />
              <Route path="/my-orders" element={<MyOrdersPage />} />
              <Route path="/farm" element={<FarmAdvisorPage />} />
              <Route path="/build-analyzer" element={<BuildAnalyzerPage />} />
              <Route path="/build-tracker" element={<BuildTrackerPage />} />
              <Route path="/riven" element={<RivenAdvisorPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/hub/arbitrations" element={<ArbitrationSchedulePage />} />
              <Route path="/hub/void-trader" element={<VoidTraderInventoryPage />} />
              <Route path="*" element={<Navigate to="/hub" replace />} />
            </Routes>
          </main>
        </div>
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
