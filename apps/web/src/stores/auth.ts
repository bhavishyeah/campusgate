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
  hydrated: boolean;
  setAuth: (token: string, user: UserInfo) => void;
  logout: () => void;
  setHydrated: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      hydrated: false,
      setAuth: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
      setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: "campusgate-auth",
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    }
  )
);
