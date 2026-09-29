import { Navigate, Route, Routes } from "react-router-dom";
import { AudiencePage } from "./pages/AudiencePage";
import { OperatorPage } from "./pages/OperatorPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<AudiencePage />} />
      <Route path="/operator" element={<OperatorPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
