import ReactDOM from "react-dom/client";
import RewardOverlay from "./components/RewardOverlay";
import TradeSuccessOverlay from "./components/TradeSuccessOverlay";
import "./index.css";

ReactDOM.createRoot(document.getElementById("overlay-root")!).render(
  <>
    <RewardOverlay />
    <TradeSuccessOverlay />
  </>
);
