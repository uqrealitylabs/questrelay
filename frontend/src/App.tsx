import { Navigate, Route, Routes } from "react-router-dom";
import { AudiencePage, HomePage } from "./pages/AudiencePage";
import { OperatorPage } from "./pages/OperatorPage";
import { Invite } from "./pages/Invite";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/livestream/:id" element={<AudiencePage />} />
      <Route path="/admin" element={<OperatorPage />} />
      <Route path="/admin/invite/:token" element={<Invite />} />
      <Route path="/operator" element={<Navigate to="/admin" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
