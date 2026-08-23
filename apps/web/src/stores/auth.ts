import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UserInfo {
  id: string;
  email: string;
  role: "STUDENT" | "HOD" | "GUARD" | "ADMIN";
  accountStatus: string;
  profile?: any;
}

interface AuthState {
  token: string | null;
  user: UserInfo | null;
  setAuth: (token: string, user: UserInfo) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: "campusgate-auth",
    }
  )
);
